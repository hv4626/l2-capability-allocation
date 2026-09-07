from __future__ import annotations

import os
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from l0_foundation.channels import FireAndForgetBus
from l0_foundation.comparators import COMPARATORS
from l0_foundation.l1_engine import evaluate_signals_l1, sync_all_unsynced, sync_reserve_bound
from l0_foundation.l2_engine import ingest_telemetry, release_event, seed_telemetry_now, tick_layer
from l0_foundation.entities import (
    DEVICE_ACTIVE,
    DEVICE_STATUSES,
    BroadcastList,
    Channel,
    Device,
    IncomingSignal,
    Site,
    ThresholdRule,
)
from l0_foundation.ids import new_id
from l0_foundation.seed import seed
from l0_foundation.store import Store

_store: Store | None = None
_bus: FireAndForgetBus | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store(os.environ.get("L0_DB_URL"))
    return _store


def get_bus() -> FireAndForgetBus:
    global _bus
    if _bus is None:
        _bus = FireAndForgetBus()
    return _bus


def configure(next_store: Store, next_bus: FireAndForgetBus | None = None) -> None:
    global _store, _bus
    _store = next_store
    _bus = next_bus or FireAndForgetBus()

app = FastAPI(title="L2 Capability Allocation", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SiteIn(BaseModel):
    site_id: str | None = None
    customer_id: str
    utility_territory: str


class ChannelIn(BaseModel):
    channel_id: str | None = None
    channel_type: str
    endpoint: str


class DeviceIn(BaseModel):
    device_id: str | None = None
    site_id: str
    channel_id: str
    device_class: str
    rated_capacity_kw: float
    reserve_bound_pct: float = Field(
        description="Stored only. L0 never reads this. L1 failsafe / L2 slack will."
    )
    device_status: str = Field(
        default="active",
        description="active | paused | decommissioned. Not L1 dispatch_status.",
    )


class ListIn(BaseModel):
    list_id: str | None = None
    name: str


class MemberIn(BaseModel):
    device_id: str


class RuleIn(BaseModel):
    rule_id: str | None = None
    signal_source: str
    comparator: str
    threshold_value: float
    list_id: str
    fixed_instruction: str = ""
    priority: int = 100
    is_active: bool = True
    instruction_type: str = "fixed"
    target_kw: float | None = None
    duration_min: int | None = None


class TelemetryIn(BaseModel):
    device_id: str
    soc_pct: float
    p_ac_kw: float = 0.0
    source: str = "manual"


class SignalIn(BaseModel):
    source: str
    value: float
    signal_id: str | None = None


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "layer": "L2"}


@app.get("/api/meta")
def meta() -> dict:
    return {
        "question": "how much can each device give, and how should a fleet target be split?",
        "comparators": list(COMPARATORS),
        "absent": [
            "forecasts",
            "multi_period",
            "baseline_m_and_v",
            "market_price",
        ],
        "device_statuses": list(DEVICE_STATUSES),
    }


@app.post("/api/seed")
def seed_fleet() -> dict:
    seed(get_store())
    return snapshot()


@app.get("/api/snapshot")
def snapshot() -> dict:
    store = get_store()
    lists = store.list_broadcast_lists()
    return {
        "sites": [asdict(x) for x in store.list_sites()],
        "channels": [asdict(x) for x in store.list_channels()],
        "devices": [asdict(x) for x in store.list_devices()],
        "lists": [
            {
                **asdict(lst),
                "device_ids": [m.device_id for m in store.memberships(lst.list_id)],
            }
            for lst in lists
        ],
        "rules": [asdict(x) for x in store.list_rules()],
        "dispatch_log": [_event_out(x) for x in store.list_dispatch_log()],
        "sends": [_send_out(x) for x in reversed(get_bus().attempts)],
        "messages": [_message_out(x) for x in store.list_messages()],
        "capabilities": [asdict(x) for x in store.list_capabilities()],
        "telemetry": [_telemetry_out(x) for x in store.list_telemetry()],
        "solver_runs": [_run_out(x) for x in store.list_solver_runs()],
        "allocations": [_alloc_out(x) for x in store.list_allocations()],
        "reservations": [_res_out(x) for x in store.list_reservations()],
    }


@app.get("/api/sites")
def list_sites() -> list[dict]:
    return [asdict(x) for x in get_store().list_sites()]


@app.post("/api/sites")
def create_site(body: SiteIn) -> dict:
    site = Site(body.site_id or new_id("site"), body.customer_id, body.utility_territory)
    return asdict(get_store().put_site(site))


@app.put("/api/sites/{site_id}")
def update_site(site_id: str, body: SiteIn) -> dict:
    return asdict(get_store().put_site(Site(site_id, body.customer_id, body.utility_territory)))


@app.delete("/api/sites/{site_id}")
def delete_site(site_id: str) -> dict:
    try:
        get_store().delete_site(site_id)
    except KeyError:
        raise HTTPException(404, "site not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"deleted": site_id}


@app.get("/api/channels")
def list_channels() -> list[dict]:
    return [asdict(x) for x in get_store().list_channels()]


@app.post("/api/channels")
def create_channel(body: ChannelIn) -> dict:
    return asdict(
        get_store().put_channel(
            Channel(body.channel_id or new_id("channel"), body.channel_type, body.endpoint)
        )
    )


@app.put("/api/channels/{channel_id}")
def update_channel(channel_id: str, body: ChannelIn) -> dict:
    return asdict(get_store().put_channel(Channel(channel_id, body.channel_type, body.endpoint)))


@app.delete("/api/channels/{channel_id}")
def delete_channel(channel_id: str) -> dict:
    try:
        get_store().delete_channel(channel_id)
    except KeyError:
        raise HTTPException(404, "channel not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"deleted": channel_id}


@app.get("/api/devices")
def list_devices() -> list[dict]:
    return [asdict(x) for x in get_store().list_devices()]


def _require_device_status(status: str) -> None:
    if status not in DEVICE_STATUSES:
        raise HTTPException(400, f"device_status must be one of {list(DEVICE_STATUSES)}")


@app.post("/api/devices")
def create_device(body: DeviceIn) -> dict:
    _require_device_status(body.device_status)
    try:
        return asdict(
            get_store().put_device(
                Device(
                    body.device_id or new_id("device"),
                    body.site_id,
                    body.channel_id,
                    body.device_class,
                    body.rated_capacity_kw,
                    body.reserve_bound_pct,
                    body.device_status,
                )
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.put("/api/devices/{device_id}")
def update_device(device_id: str, body: DeviceIn) -> dict:
    _require_device_status(body.device_status)
    try:
        return asdict(
            get_store().put_device(
                Device(
                    device_id,
                    body.site_id,
                    body.channel_id,
                    body.device_class,
                    body.rated_capacity_kw,
                    body.reserve_bound_pct,
                    body.device_status,
                )
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.delete("/api/devices/{device_id}")
def delete_device(device_id: str) -> dict:
    try:
        get_store().delete_device(device_id)
    except KeyError:
        raise HTTPException(404, "device not found") from None
    return {"deleted": device_id}


@app.get("/api/lists")
def list_lists() -> list[dict]:
    store = get_store()
    return [
        {**asdict(lst), "device_ids": [m.device_id for m in store.memberships(lst.list_id)]}
        for lst in store.list_broadcast_lists()
    ]


@app.post("/api/lists")
def create_list(body: ListIn) -> dict:
    lst = get_store().put_list(BroadcastList(body.list_id or new_id("list"), body.name))
    return {**asdict(lst), "device_ids": []}


@app.put("/api/lists/{list_id}")
def update_list(list_id: str, body: ListIn) -> dict:
    store = get_store()
    lst = store.put_list(BroadcastList(list_id, body.name))
    return {
        **asdict(lst),
        "device_ids": [m.device_id for m in store.memberships(list_id)],
    }


@app.delete("/api/lists/{list_id}")
def delete_list(list_id: str) -> dict:
    try:
        get_store().delete_list(list_id)
    except KeyError:
        raise HTTPException(404, "list not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"deleted": list_id}


@app.post("/api/lists/{list_id}/members")
def add_member(list_id: str, body: MemberIn) -> dict:
    try:
        member = get_store().add_member(list_id, body.device_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return asdict(member)


@app.delete("/api/lists/{list_id}/members/{device_id}")
def remove_member(list_id: str, device_id: str) -> dict:
    try:
        get_store().remove_member(list_id, device_id)
    except KeyError:
        raise HTTPException(404, "membership not found") from None
    return {"deleted": {"list_id": list_id, "device_id": device_id}}


@app.get("/api/rules")
def list_rules() -> list[dict]:
    return [asdict(x) for x in get_store().list_rules()]


@app.post("/api/rules")
def create_rule(body: RuleIn) -> dict:
    if body.comparator not in COMPARATORS:
        raise HTTPException(400, f"comparator must be one of {list(COMPARATORS)}")
    try:
        return asdict(
            get_store().put_rule(
                ThresholdRule(
                    body.rule_id or new_id("rule"),
                    body.signal_source,
                    body.comparator,
                    body.threshold_value,
                    body.list_id,
                    body.fixed_instruction,
                    body.priority,
                    body.is_active,
                    body.instruction_type,
                    body.target_kw,
                    body.duration_min,
                )
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.put("/api/rules/{rule_id}")
def update_rule(rule_id: str, body: RuleIn) -> dict:
    if body.comparator not in COMPARATORS:
        raise HTTPException(400, f"comparator must be one of {list(COMPARATORS)}")
    try:
        return asdict(
            get_store().put_rule(
                ThresholdRule(
                    rule_id,
                    body.signal_source,
                    body.comparator,
                    body.threshold_value,
                    body.list_id,
                    body.fixed_instruction,
                    body.priority,
                    body.is_active,
                    body.instruction_type,
                    body.target_kw,
                    body.duration_min,
                )
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: str) -> dict:
    try:
        get_store().delete_rule(rule_id)
    except KeyError:
        raise HTTPException(404, "rule not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"deleted": rule_id}


@app.get("/api/dispatch-log")
def dispatch_log() -> list[dict]:
    return [_event_out(x) for x in get_store().list_dispatch_log()]


@app.get("/api/sends")
def sends() -> list[dict]:
    return [_send_out(x) for x in reversed(get_bus().attempts)]


@app.post("/api/signals")
def inject_signal(body: SignalIn) -> dict:
    """Run the L0 loop for one incoming signal. Fire-and-forget."""
    from l0_foundation.comparators import compare

    store = get_store()
    bus = get_bus()
    signal_id = body.signal_id or new_id("signal")
    matching = store.threshold_rules_where(body.source)
    fired = evaluate_signals_l1(
        [IncomingSignal(body.source, body.value, signal_id)], store, bus
    )
    fired_ids = {e.rule_id for e in fired}
    skipped_duplicate = False
    trace = []
    for rule in matching:
        crossed = compare(body.value, rule.comparator, rule.threshold_value)
        dup = crossed and store.dispatch_exists(rule.rule_id, signal_id) and rule.rule_id not in fired_ids
        if dup:
            skipped_duplicate = True
        sent_ids: list[str] = []
        if crossed and rule.rule_id in fired_ids:
            for device in store.devices_on_list(rule.list_id):
                if device.device_status != DEVICE_ACTIVE:
                    continue
                sent_ids.append(device.device_id)
        trace.append(
            {
                "rule_id": rule.rule_id,
                "comparator": rule.comparator,
                "threshold_value": rule.threshold_value,
                "list_id": rule.list_id,
                "fixed_instruction": rule.fixed_instruction,
                "priority": rule.priority,
                "crossed": crossed,
                "skipped_duplicate": dup,
                "device_ids": sent_ids,
            }
        )
    return {
        "signal": {"source": body.source, "value": body.value, "signal_id": signal_id},
        "skipped_duplicate": skipped_duplicate,
        "matching_rule_ids": [r.rule_id for r in matching],
        "fired_event_ids": [e.event_id for e in fired],
        "trace": trace,
        "dispatch_log": [_event_out(x) for x in store.list_dispatch_log()],
        "sends": [_send_out(x) for x in reversed(bus.attempts)],
        "messages": [_message_out(x) for x in store.list_messages()],
        "solver_runs": [_run_out(x) for x in store.list_solver_runs()],
        "allocations": [_alloc_out(x) for x in store.list_allocations()],
    }


@app.get("/api/messages")
def list_messages() -> list[dict]:
    return [_message_out(x) for x in get_store().list_messages()]


@app.post("/api/config-sync")
def config_sync(device_id: str | None = None) -> dict:
    store = get_store()
    bus = get_bus()
    if device_id:
        device = store.get_device(device_id)
        sync_reserve_bound(store, bus, device)
    else:
        sync_all_unsynced(store, bus)
    return snapshot()


@app.post("/api/tick")
def tick() -> dict:
    tick_layer(get_store(), get_bus())
    return snapshot()


def _event_out(event) -> dict:
    triggered = event.triggered_at
    if isinstance(triggered, datetime):
        triggered_at = triggered.isoformat()
    else:
        triggered_at = str(triggered)
    return {
        "event_id": event.event_id,
        "rule_id": event.rule_id,
        "triggered_at": triggered_at,
        "instruction_text": event.instruction_text,
        "signal_id": event.signal_id,
    }


def _message_out(msg) -> dict:
    sent = msg.sent_at.isoformat() if isinstance(msg.sent_at, datetime) else str(msg.sent_at)
    ack = None
    if msg.ack_at is not None:
        ack = msg.ack_at.isoformat() if isinstance(msg.ack_at, datetime) else str(msg.ack_at)
    return {
        "message_id": msg.message_id,
        "device_id": msg.device_id,
        "event_id": msg.event_id,
        "message_type": msg.message_type,
        "payload": msg.payload,
        "status": msg.status,
        "sent_at": sent,
        "ack_at": ack,
        "timeout_seconds": msg.timeout_seconds,
        "attempt_number": msg.attempt_number,
        "retry_of_message_id": msg.retry_of_message_id,
        "allocation_id": msg.allocation_id,
    }


@app.post("/api/telemetry")
def post_telemetry(body: TelemetryIn) -> dict:
    try:
        ingest_telemetry(get_store(), body.device_id, body.soc_pct, body.p_ac_kw, source=body.source)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return snapshot()


@app.post("/api/telemetry/seed")
def post_telemetry_seed() -> dict:
    seed_telemetry_now(get_store())
    return snapshot()


@app.post("/api/events/{event_id}/release")
def post_release(event_id: str, reason: str = "event_cancelled") -> dict:
    try:
        release_event(get_store(), get_bus(), event_id, reason=reason)
    except KeyError:
        raise HTTPException(404, "event not found") from None
    return snapshot()


def _iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _telemetry_out(row) -> dict:
    return {
        "sample_id": row.sample_id,
        "device_id": row.device_id,
        "observed_at": _iso(row.observed_at),
        "ingested_at": _iso(row.ingested_at),
        "soc_pct": row.soc_pct,
        "p_ac_kw": row.p_ac_kw,
        "source": row.source,
    }


def _run_out(row) -> dict:
    return {
        "run_id": row.run_id,
        "event_id": row.event_id,
        "run_number": row.run_number,
        "solved_at": _iso(row.solved_at),
        "telemetry_cutoff_at": _iso(row.telemetry_cutoff_at),
        "target_kw": row.target_kw,
        "eligible_count": row.eligible_count,
        "total_headroom_kw": row.total_headroom_kw,
        "allocated_kw": row.allocated_kw,
        "shortfall_kw": row.shortfall_kw,
        "lambda": row.lam,
        "sites_binding_count": row.sites_binding_count,
        "quantization_loss_kw": row.quantization_loss_kw,
        "status": row.status,
    }


def _alloc_out(row) -> dict:
    d = asdict(row)
    return d


def _res_out(row) -> dict:
    d = asdict(row)
    d["held_from"] = _iso(row.held_from)
    d["held_until"] = _iso(row.held_until)
    return d


def _send_out(send) -> dict:
    return {
        "send_id": send.send_id,
        "channel_id": send.channel_id,
        "channel_type": send.channel_type,
        "endpoint": send.endpoint,
        "instruction_text": send.instruction_text,
        "attempted_at": send.attempted_at.isoformat(),
    }


WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str, request: Request):
        if path.startswith("api/"):
            raise HTTPException(404)
        index = WEB_DIST / "index.html"
        file = WEB_DIST / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(index)
