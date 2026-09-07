"""L1 control channel — did it land, and is the failsafe configured.

Does not replace L0. Adds a return path on Channel.send, per-device
CHANNEL_MESSAGE rows, retries, and independent config sync of
reserve_bound_pct.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta, timezone

from l0_foundation.channels import ChannelSender
from l0_foundation.comparators import compare
from l0_foundation.entities import (
    DEVICE_ACTIVE,
    ChannelMessage,
    Device,
    DispatchLog,
    IncomingSignal,
)
from l0_foundation.ids import new_id
from l0_foundation.store import Store

MAX_DISPATCH_RETRIES = 2
MAX_CONFIG_RETRIES = 3
MAX_RELEASE_RETRIES = 1
DEFAULT_ACK_TIMEOUT = 5
CONFIG_SYNC_TIMEOUT = 8


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def evaluate_signals_l1(
    incoming_signals: Iterable[IncomingSignal],
    store: Store,
    channel: ChannelSender,
    *,
    now: datetime | None = None,
) -> list[DispatchLog]:
    triggered_at = _now(now)
    created: list[DispatchLog] = []

    for signal in incoming_signals:
        signal_id = signal.signal_id or new_id("signal")
        matching_rules = store.threshold_rules_where(signal.source)
        for rule in matching_rules:
            if not compare(signal.value, rule.comparator, rule.threshold_value):
                continue
            if store.dispatch_exists(rule.rule_id, signal_id):
                continue
            instruction = rule.fixed_instruction
            if getattr(rule, "instruction_type", "fixed") == "fleet_target":
                instruction = f"FLEET_TARGET {rule.target_kw}kW {rule.duration_min}min"
            event = store.create_dispatch_log(
                rule_id=rule.rule_id,
                triggered_at=triggered_at,
                instruction_text=instruction,
                signal_id=signal_id,
            )
            created.append(event)
            if getattr(rule, "instruction_type", "fixed") == "fleet_target":
                from l0_foundation.l2_engine import allocate_event

                allocate_event(store, channel, event, rule, now=triggered_at)
                continue
            for device in store.devices_on_list(rule.list_id):
                if device.device_status != DEVICE_ACTIVE:
                    continue
                if store.has_in_flight(device.device_id):
                    continue
                send_dispatch_attempt(
                    store,
                    channel,
                    device,
                    event,
                    rule.fixed_instruction,
                    attempt_number=1,
                    retry_of=None,
                    now=triggered_at,
                )
    return created


def send_dispatch_attempt(
    store: Store,
    channel: ChannelSender,
    device: Device,
    event: DispatchLog,
    instruction: str,
    attempt_number: int,
    retry_of: str | None,
    now: datetime | None = None,
) -> ChannelMessage:
    sent_at = _now(now)
    msg = store.create_message(
        ChannelMessage(
            message_id=new_id("message"),
            device_id=device.device_id,
            event_id=event.event_id,
            message_type="dispatch_instruction",
            payload=instruction,
            status="pending",
            sent_at=sent_at,
            ack_at=None,
            timeout_seconds=DEFAULT_ACK_TIMEOUT,
            attempt_number=attempt_number,
            retry_of_message_id=retry_of,
        )
    )
    store.set_dispatch_state(device.device_id, "dispatched")
    ch = store.get_channel(device.channel_id)

    def _cb(ok: bool, message_id: str = msg.message_id) -> None:
        handle_ack(store, channel, message_id, ok)

    channel.send(ch, instruction, on_ack=_cb)
    return msg


def handle_ack(store: Store, channel: ChannelSender, message_id: str, success: bool, now: datetime | None = None) -> None:
    at = _now(now)
    updated = store.update_message_if_status(
        message_id,
        "pending",
        status="acked" if success else "nacked",
        ack_at=at,
    )
    if updated is None:
        return
    if success:
        if updated.message_type in ("dispatch_instruction", "setpoint_revision"):
            store.set_dispatch_state(updated.device_id, "completed")
            if updated.allocation_id:
                from l0_foundation.l2_engine import on_allocation_acked

                on_allocation_acked(store, updated)
        elif updated.message_type == "release":
            store.set_dispatch_state(updated.device_id, "idle")
        else:
            store.set_config(updated.device_id, "synced", synced_at=at)
        return
    retry_or_fail(store, channel, updated, now=at)


def tick_timeouts(store: Store, channel: ChannelSender, now: datetime | None = None) -> list[str]:
    at = _now(now)
    claimed: list[str] = []
    for msg in store.pending_messages():
        deadline = msg.sent_at
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        if deadline + timedelta(seconds=msg.timeout_seconds) > at:
            continue
        updated = store.update_message_if_status(msg.message_id, "pending", status="timed_out")
        if updated is None:
            continue
        claimed.append(updated.message_id)
        retry_or_fail(store, channel, updated, now=at)
    return claimed


def retry_or_fail(
    store: Store,
    channel: ChannelSender,
    msg: ChannelMessage,
    now: datetime | None = None,
) -> None:
    device = store.get_device(msg.device_id)
    if msg.message_type in ("dispatch_instruction", "setpoint_revision") and msg.attempt_number <= MAX_DISPATCH_RETRIES:
        event = next(e for e in store.list_dispatch_log() if e.event_id == msg.event_id)
        if msg.allocation_id:
            from l0_foundation.l2_engine import send_typed

            send_typed(
                store,
                channel,
                device,
                event,
                msg.message_type,
                msg.payload,
                msg.allocation_id,
                attempt_number=msg.attempt_number + 1,
                retry_of=msg.message_id,
                now=now,
            )
        else:
            send_dispatch_attempt(
                store,
                channel,
                device,
                event,
                msg.payload,
                attempt_number=msg.attempt_number + 1,
                retry_of=msg.message_id,
                now=now,
            )
        return
    if msg.message_type == "release" and msg.attempt_number <= MAX_RELEASE_RETRIES:
        event = next(e for e in store.list_dispatch_log() if e.event_id == msg.event_id)
        from l0_foundation.l2_engine import send_typed

        send_typed(
            store,
            channel,
            device,
            event,
            "release",
            msg.payload,
            msg.allocation_id,
            attempt_number=msg.attempt_number + 1,
            retry_of=msg.message_id,
            now=now,
        )
        return
    if msg.message_type == "config_sync" and msg.attempt_number <= MAX_CONFIG_RETRIES:
        sync_reserve_bound(store, channel, device, attempt_number=msg.attempt_number + 1, retry_of=msg.message_id, now=now)
        return
    if msg.message_type in ("dispatch_instruction", "setpoint_revision"):
        store.set_dispatch_state(msg.device_id, "failed")
        if msg.allocation_id:
            from l0_foundation.l2_engine import on_terminal_failure

            on_terminal_failure(store, channel, msg, now=now)
    elif msg.message_type == "release":
        store.set_dispatch_state(msg.device_id, "idle")
    else:
        store.set_config(msg.device_id, "failed")


def sync_reserve_bound(
    store: Store,
    channel: ChannelSender,
    device: Device,
    attempt_number: int = 1,
    retry_of: str | None = None,
    now: datetime | None = None,
) -> ChannelMessage:
    sent_at = _now(now)
    payload = str(device.reserve_bound_pct)
    msg = store.create_message(
        ChannelMessage(
            message_id=new_id("message"),
            device_id=device.device_id,
            event_id=None,
            message_type="config_sync",
            payload=payload,
            status="pending",
            sent_at=sent_at,
            ack_at=None,
            timeout_seconds=CONFIG_SYNC_TIMEOUT,
            attempt_number=attempt_number,
            retry_of_message_id=retry_of,
        )
    )
    store.set_config(device.device_id, "pending")
    ch = store.get_channel(device.channel_id)

    def _cb(ok: bool, message_id: str = msg.message_id) -> None:
        handle_config_ack(store, channel, device.device_id, message_id, ok)

    channel.send(ch, f"FAILSAFE_RESERVE {payload}", on_ack=_cb)
    return msg


def handle_config_ack(
    store: Store,
    channel: ChannelSender,
    device_id: str,
    message_id: str,
    success: bool,
    now: datetime | None = None,
) -> None:
    at = _now(now)
    updated = store.update_message_if_status(
        message_id,
        "pending",
        status="acked" if success else "nacked",
        ack_at=at,
    )
    if updated is None:
        return
    if success:
        store.set_config(device_id, "synced", synced_at=at)
        return
    retry_or_fail(store, channel, updated, now=at)


def sync_all_unsynced(store: Store, channel: ChannelSender) -> int:
    n = 0
    for device in store.list_devices():
        if device.config_status in ("unsynced", "stale", "failed"):
            sync_reserve_bound(store, channel, device)
            n += 1
    return n
