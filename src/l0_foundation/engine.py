"""L0 rule-evaluation loop (v2).

Idempotency is per (rule_id, signal_id). device_status filters who is
sent; it is not a per-event delivery state.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Protocol

from l0_foundation.channels import ChannelSender
from l0_foundation.comparators import compare
from l0_foundation.entities import DEVICE_ACTIVE, Channel, Device, DispatchLog, IncomingSignal, ThresholdRule
from l0_foundation.ids import new_id


class EngineStore(Protocol):
    def threshold_rules_where(self, signal_source: str) -> list[ThresholdRule]: ...

    def devices_on_list(self, list_id: str) -> list[Device]: ...

    def get_channel(self, channel_id: str) -> Channel: ...

    def dispatch_exists(self, rule_id: str, signal_id: str) -> bool: ...

    def create_dispatch_log(
        self,
        *,
        rule_id: str,
        triggered_at: datetime,
        instruction_text: str,
        signal_id: str,
    ) -> DispatchLog: ...


def evaluate_signals(
    incoming_signals: Iterable[IncomingSignal],
    store: EngineStore,
    channel: ChannelSender,
    *,
    now: datetime | None = None,
) -> list[DispatchLog]:
    triggered_at = now or datetime.now(timezone.utc)
    created: list[DispatchLog] = []

    for signal in incoming_signals:
        signal_id = signal.signal_id or new_id("signal")
        matching_rules = store.threshold_rules_where(signal.source)
        for rule in matching_rules:
            if compare(signal.value, rule.comparator, rule.threshold_value):
                if store.dispatch_exists(rule.rule_id, signal_id):
                    continue
                devices = store.devices_on_list(rule.list_id)
                for device in devices:
                    if device.device_status != DEVICE_ACTIVE:
                        continue
                    ch = store.get_channel(device.channel_id)
                    channel.send(ch, rule.fixed_instruction)
                created.append(
                    store.create_dispatch_log(
                        rule_id=rule.rule_id,
                        triggered_at=triggered_at,
                        instruction_text=rule.fixed_instruction,
                        signal_id=signal_id,
                    )
                )

    return created
