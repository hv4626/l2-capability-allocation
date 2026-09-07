"""L2 capability & allocation — how much can each device give, and how to split a fleet target."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from l0_foundation.channels import ChannelSender
from l0_foundation.entities import (
    DEVICE_ACTIVE,
    ChannelMessage,
    Device,
    DeviceAllocation,
    DeviceCapability,
    DispatchLog,
    HeadroomReservation,
    SolverRun,
    TelemetrySample,
    ThresholdRule,
)
from l0_foundation.ids import new_id
from l0_foundation.l1_engine import (
    DEFAULT_ACK_TIMEOUT,
    MAX_DISPATCH_RETRIES,
    handle_ack,
    send_dispatch_attempt,
)
from l0_foundation.l2_solver import DeviceQP, solve_qp
from l0_foundation.store import Store

TELEMETRY_STALE_AFTER = timedelta(minutes=15)
EPS_KW = 0.01
MAX_REALLOCATIONS = 3
MAX_RELEASE_RETRIES = 1
RELEASE_TIMEOUT = 3


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def ingest_telemetry(
    store: Store,
    device_id: str,
    soc_pct: float,
    p_ac_kw: float,
    *,
    observed_at: datetime | None = None,
    source: str = "manual",
    now: datetime | None = None,
) -> TelemetrySample:
    at = _now(now)
    sample = TelemetrySample(
        sample_id=new_id("tel"),
        device_id=device_id,
        observed_at=observed_at or at,
        ingested_at=at,
        soc_pct=soc_pct,
        p_ac_kw=p_ac_kw,
        source=source,
    )
    return store.ingest_telemetry(sample)


def dead_reckon(device: Device, cap: DeviceCapability, t0: datetime) -> float:
    soc = device.last_soc_pct or 0.0
    if device.last_telemetry_at is None or device.last_p_ac_kw is None:
        return soc
    last = device.last_telemetry_at
    if last.tzinfo is None and t0.tzinfo is not None:
        last = last.replace(tzinfo=t0.tzinfo)
    dt_h = max(0.0, (t0 - last).total_seconds() / 3600.0)
    p = device.last_p_ac_kw
    e = cap.energy_capacity_kwh
    if e <= 0 or dt_h == 0:
        return soc
    if p >= 0:
        delta = (p * dt_h) / (cap.eta_discharge * e) * 100.0
        soc = soc - delta
    else:
        delta = ((-p) * dt_h * cap.eta_charge) / e * 100.0
        soc = soc + delta
    return max(cap.soc_min_pct, min(cap.soc_max_pct, soc))


def effective_floor(device: Device, cap: DeviceCapability, site_floor: float | None) -> float:
    return max(cap.soc_min_pct, device.reserve_bound_pct, site_floor or 0.0)


def energy_held(store: Store, device_id: str, now: datetime) -> float:
    return sum(r.reserved_energy_kwh for r in store.live_reservations(now) if r.device_id == device_id)


def power_held(store: Store, device_id: str, now: datetime) -> float:
    return sum(r.reserved_kw for r in store.live_reservations(now) if r.device_id == device_id)


def power_held_at_site(store: Store, site_id: str, now: datetime) -> float:
    return sum(r.reserved_kw for r in store.live_reservations(now) if r.site_id == site_id)


def eligible_devices(store: Store, list_id: str, now: datetime) -> list[Device]:
    out: list[Device] = []
    for device in store.devices_on_list(list_id):
        if device.device_status != DEVICE_ACTIVE:
            continue
        if device.config_status != "synced":
            continue
        if store.has_in_flight(device.device_id):
            continue
        if device.opt_out_until is not None:
            until = device.opt_out_until
            if until.tzinfo is None and now.tzinfo is not None:
                until = until.replace(tzinfo=now.tzinfo)
            if until > now:
                continue
        if device.last_telemetry_at is None:
            continue
        last = device.last_telemetry_at
        if last.tzinfo is None and now.tzinfo is not None:
            last = last.replace(tzinfo=now.tzinfo)
        if now - last > TELEMETRY_STALE_AFTER:
            continue
        if store.get_capability(device.device_id) is None:
            continue
        out.append(device)
    return out


def _headroom(
    store: Store,
    device: Device,
    cap: DeviceCapability,
    site,
    now: datetime,
    duration_h: float,
    discharge: bool,
) -> tuple[float, float, float, str]:
    floor = effective_floor(device, cap, site.contract_floor_soc_pct)
    soc = dead_reckon(device, cap, now)
    if discharge:
        a = cap.energy_capacity_kwh * max(0.0, soc - floor) / 100.0
        a -= energy_held(store, device.device_id, now)
        s = cap.eta_discharge * max(0.0, a) / duration_h if duration_h > 0 else 0.0
        pbar = max(0.0, min(cap.p_discharge_max_kw - power_held(store, device.device_id, now), s))
        if abs(pbar - max(0.0, cap.p_discharge_max_kw - power_held(store, device.device_id, now))) < EPS_KW:
            bind = "power"
        elif pbar <= EPS_KW:
            bind = "energy"
        else:
            bind = "energy" if s < cap.p_discharge_max_kw else "power"
    else:
        a = cap.energy_capacity_kwh * max(0.0, cap.soc_max_pct - soc) / 100.0
        a -= energy_held(store, device.device_id, now)
        s = max(0.0, a) / (cap.eta_charge * duration_h) if duration_h > 0 else 0.0
        pbar = max(0.0, min(cap.p_charge_max_kw - abs(power_held(store, device.device_id, now)), s))
        bind = "power" if pbar + EPS_KW >= cap.p_charge_max_kw else "energy"
    return pbar, soc, floor, bind


def allocate_event(
    store: Store,
    channel: ChannelSender,
    event: DispatchLog,
    rule: ThresholdRule,
    *,
    now: datetime | None = None,
    run_number: int = 1,
    residual: float | None = None,
    exclude_failed: set[str] | None = None,
) -> SolverRun | None:
    t0 = _now(now)
    r = residual if residual is not None else (rule.target_kw or 0.0)
    duration_min = rule.duration_min or 30
    duration_h = duration_min / 60.0
    expires_at = t0 + timedelta(minutes=duration_min)
    discharge = r >= 0
    abs_r = abs(r)

    eligible = eligible_devices(store, rule.list_id, t0)
    if exclude_failed:
        eligible = [d for d in eligible if d.device_id not in exclude_failed]
    if run_number > 1:
        # re-allocation candidates: unused this event, or remaining headroom
        used = {a.device_id for a in store.list_allocations(event.event_id) if a.status == "failed"}
        extra = []
        for a in store.list_allocations(event.event_id):
            if a.status in ("sent", "confirmed") and a.headroom_kw - abs(a.p_setpoint_kw) > EPS_KW:
                extra.append(store.get_device(a.device_id))
        seen = {d.device_id for d in eligible}
        for d in extra:
            if d.device_id not in seen and d.device_id not in used:
                eligible.append(d)
                seen.add(d.device_id)
        eligible = [d for d in eligible if d.device_id not in used]

    if not eligible:
        run = SolverRun(
            run_id=new_id("run"),
            event_id=event.event_id,
            run_number=run_number,
            solved_at=t0,
            telemetry_cutoff_at=t0,
            target_kw=r,
            eligible_count=0,
            total_headroom_kw=0.0,
            allocated_kw=0.0,
            shortfall_kw=abs_r,
            lam=0.0,
            sites_binding_count=0,
            quantization_loss_kw=0.0,
            status="no_eligible_devices",
        )
        return store.create_solver_run(run)

    qp_devices: list[DeviceQP] = []
    meta: dict[str, dict] = {}
    g_k: dict[str, float] = {}
    sites = {s.site_id: s for s in store.list_sites()}

    for device in eligible:
        cap = store.get_capability(device.device_id)
        if cap is None:
            continue
        site = sites[device.site_id]
        pbar, soc, floor, bind = _headroom(store, device, cap, site, t0, duration_h, discharge)
        limit = site.export_limit_kw if discharge else site.import_limit_kw
        held_site = power_held_at_site(store, site.site_id, t0)
        g = float("inf") if limit is None else max(0.0, limit - held_site)
        members_here = [d for d in eligible if d.site_id == site.site_id]
        if len(members_here) == 1:
            pbar = min(pbar, g if g != float("inf") else pbar)
            if limit is not None and abs(pbar - g) < EPS_KW:
                bind = "site"
        g_k[site.site_id] = g
        c = (1.0 / pbar) if pbar > EPS_KW else float("inf")
        qp_devices.append(
            DeviceQP(
                device_id=device.device_id,
                site_id=device.site_id,
                pbar=pbar,
                c=c,
                step=cap.setpoint_step_kw,
                binary=cap.control_mode == "binary",
            )
        )
        meta[device.device_id] = {
            "cap": cap,
            "soc": soc,
            "floor": floor,
            "pbar": pbar,
            "bind": bind,
            "device": device,
        }

    result = solve_qp(abs_r, qp_devices, g_k)
    sign = 1.0 if discharge else -1.0
    allocated = sum(result.p.values()) * sign
    status = "optimal" if result.shortfall <= EPS_KW else "degraded"
    run = store.create_solver_run(
        SolverRun(
            run_id=new_id("run"),
            event_id=event.event_id,
            run_number=run_number,
            solved_at=t0,
            telemetry_cutoff_at=t0,
            target_kw=r,
            eligible_count=len(qp_devices),
            total_headroom_kw=sum(d.pbar for d in qp_devices) * sign,
            allocated_kw=allocated,
            shortfall_kw=result.shortfall,
            lam=result.lam,
            sites_binding_count=result.sites_binding,
            quantization_loss_kw=result.quantization_loss,
            status=status,
        )
    )

    created: list[DeviceAllocation] = []
    for did, p_abs in result.p.items():
        if p_abs <= EPS_KW:
            continue
        info = meta[did]
        cap: DeviceCapability = info["cap"]
        p = p_abs * sign
        raw = result.p_raw.get(did, p_abs) * sign
        eta = cap.eta_discharge if discharge else cap.eta_charge
        energy = abs(p) * duration_h / eta if eta else 0.0
        alloc = store.create_allocation(
            DeviceAllocation(
                allocation_id=new_id("alloc"),
                run_id=run.run_id,
                device_id=did,
                capability_version=cap.capability_version,
                soc_at_solve_pct=info["soc"],
                floor_soc_pct=info["floor"],
                headroom_kw=info["pbar"] * sign,
                p_setpoint_kw=p,
                p_setpoint_raw_kw=raw,
                expected_energy_kwh=energy,
                binding_constraint=info["bind"],
                status="pending",
            )
        )
        store.create_reservation(
            HeadroomReservation(
                reservation_id=new_id("rsv"),
                device_id=did,
                site_id=info["device"].site_id,
                run_id=run.run_id,
                reserved_kw=p,
                reserved_energy_kwh=energy,
                held_from=t0,
                held_until=expires_at,
                status="held",
                allocation_id=alloc.allocation_id,
            )
        )
        created.append(alloc)

    for alloc in created:
        live = [
            a
            for a in store.list_allocations(event.event_id)
            if a.device_id == alloc.device_id and a.status in ("sent", "confirmed") and a.allocation_id != alloc.allocation_id
        ]
        payload = json.dumps(
            {
                "p_setpoint_kw": alloc.p_setpoint_kw,
                "duration_min": duration_min,
                "expires_at": expires_at.isoformat(),
            }
        )
        device = store.get_device(alloc.device_id)
        if live:
            new_p = live[0].p_setpoint_kw + alloc.p_setpoint_kw
            payload = json.dumps(
                {
                    "p_setpoint_kw": new_p,
                    "duration_min": duration_min,
                    "expires_at": expires_at.isoformat(),
                }
            )
            send_typed(
                store,
                channel,
                device,
                event,
                "setpoint_revision",
                payload,
                alloc.allocation_id,
                now=t0,
            )
            store.set_allocation_status(live[0].allocation_id, "superseded")
        else:
            send_typed(
                store,
                channel,
                device,
                event,
                "dispatch_instruction",
                payload,
                alloc.allocation_id,
                now=t0,
            )
        store.set_allocation_status(alloc.allocation_id, "sent")
    return run


def send_typed(
    store: Store,
    channel: ChannelSender,
    device: Device,
    event: DispatchLog,
    message_type: str,
    payload: str,
    allocation_id: str | None,
    *,
    attempt_number: int = 1,
    retry_of: str | None = None,
    now: datetime | None = None,
) -> ChannelMessage:
    sent_at = _now(now)
    timeout = RELEASE_TIMEOUT if message_type == "release" else DEFAULT_ACK_TIMEOUT
    msg = store.create_message(
        ChannelMessage(
            message_id=new_id("message"),
            device_id=device.device_id,
            event_id=event.event_id,
            message_type=message_type,
            payload=payload,
            status="pending",
            sent_at=sent_at,
            ack_at=None,
            timeout_seconds=timeout,
            attempt_number=attempt_number,
            retry_of_message_id=retry_of,
            allocation_id=allocation_id,
        )
    )
    if message_type != "release":
        store.set_dispatch_state(device.device_id, "dispatched")
    ch = store.get_channel(device.channel_id)

    def _cb(ok: bool, message_id: str = msg.message_id) -> None:
        handle_ack(store, channel, message_id, ok)

    channel.send(ch, payload, on_ack=_cb)
    return msg


def on_allocation_acked(store: Store, msg: ChannelMessage) -> None:
    if not msg.allocation_id:
        return
    store.set_allocation_status(msg.allocation_id, "confirmed")
    store.commit_reservation_for_allocation(msg.allocation_id)


def on_terminal_failure(store: Store, channel: ChannelSender, msg: ChannelMessage, now: datetime | None = None) -> None:
    if not msg.allocation_id:
        return
    at = _now(now)
    try:
        alloc = store.get_allocation(msg.allocation_id)
    except KeyError:
        return
    store.set_allocation_status(alloc.allocation_id, "failed")
    store.release_reservation_for_allocation(alloc.allocation_id)
    run = store.get_solver_run(alloc.run_id)
    if run.run_number >= MAX_REALLOCATIONS:
        return
    event = store.get_event(run.event_id)
    rule = store.get_rule(event.rule_id)
    committed = sum(
        abs(a.p_setpoint_kw)
        for a in store.list_allocations(event.event_id)
        if a.status in ("sent", "confirmed")
    )
    target = abs(rule.target_kw or 0.0)
    residual = target - committed
    if residual <= EPS_KW:
        return
    sign = 1.0 if (rule.target_kw or 0) >= 0 else -1.0
    allocate_event(
        store,
        channel,
        event,
        rule,
        now=at,
        run_number=run.run_number + 1,
        residual=residual * sign,
        exclude_failed={alloc.device_id},
    )


def release_event(
    store: Store,
    channel: ChannelSender,
    event_id: str,
    reason: str = "event_complete",
    now: datetime | None = None,
) -> int:
    at = _now(now)
    event = store.get_event(event_id)
    n = 0
    for alloc in store.list_allocations(event_id):
        if alloc.status not in ("sent", "confirmed", "pending"):
            continue
        device = store.get_device(alloc.device_id)
        payload = json.dumps({"allocation_id": alloc.allocation_id, "reason": reason})
        send_typed(store, channel, device, event, "release", payload, alloc.allocation_id, now=at)
        store.set_allocation_status(alloc.allocation_id, "released")
        n += 1
    store.release_reservations_for_event(event_id)
    return n


def tick_layer(store: Store, channel: ChannelSender, now: datetime | None = None) -> None:
    """L1 timeouts plus L2 expiry sweep, auto-release, and settlement."""
    from l0_foundation.l1_engine import tick_timeouts

    at = _now(now)
    tick_timeouts(store, channel, now=at)
    auto_release_expired(store, channel, at)
    store.expire_reservations(at)
    settle_allocations(store, at)


def auto_release_expired(store: Store, channel: ChannelSender, now: datetime) -> None:
    seen: set[str] = set()
    for rsv in store.list_reservations():
        if rsv.status == "released":
            continue
        until = rsv.held_until
        if getattr(until, "tzinfo", None) is None and now.tzinfo is not None:
            until = until.replace(tzinfo=now.tzinfo)
        if until > now:
            continue
        try:
            run = store.get_solver_run(rsv.run_id)
        except KeyError:
            continue
        if run.event_id in seen:
            continue
        seen.add(run.event_id)
        live = [
            a
            for a in store.list_allocations(run.event_id)
            if a.status in ("sent", "confirmed", "pending")
        ]
        if live:
            release_event(store, channel, run.event_id, reason="event_complete", now=now)


def settle_allocations(store: Store, now: datetime) -> None:
    samples = store.list_telemetry()
    for alloc in store.list_allocations():
        if alloc.status != "confirmed" or alloc.delivered_kwh is not None:
            continue
        rsvs = [r for r in store.list_reservations() if r.allocation_id == alloc.allocation_id]
        if not rsvs:
            continue
        start, end = rsvs[0].held_from, rsvs[0].held_until
        if getattr(end, "tzinfo", None) is None and now.tzinfo is not None:
            end = end.replace(tzinfo=now.tzinfo)
        if end > now:
            continue
        pts = [
            (s.observed_at, s.p_ac_kw)
            for s in samples
            if s.device_id == alloc.device_id
        ]
        pts.sort(key=lambda x: x[0])
        if len(pts) < 2:
            dt_h = max(0.0, (end - start).total_seconds() / 3600.0)
            device = store.get_device(alloc.device_id)
            p = device.last_p_ac_kw or 0.0
            store.set_allocation_delivered(alloc.allocation_id, abs(p) * dt_h)
            continue
        energy = 0.0
        for i in range(1, len(pts)):
            t0, p0 = pts[i - 1]
            t1, p1 = pts[i]
            if t1 <= start or t0 >= end:
                continue
            dt_h = (t1 - t0).total_seconds() / 3600.0
            energy += abs((p0 + p1) / 2.0) * dt_h
        store.set_allocation_delivered(alloc.allocation_id, energy)


def seed_telemetry_now(store: Store, now: datetime | None = None) -> int:
    """Fresh samples so the demo fleet is eligible."""
    at = _now(now)
    samples = {
        "dev_jay_batt": (82.0, 0.2),
        "dev_kora_batt": (76.0, 0.0),
        "dev_and_batt": (88.0, -0.4),
        "dev_pune_batt": (70.0, 0.1),
        "dev_ady_batt": (85.0, 0.0),
    }
    n = 0
    for device_id, (soc, p) in samples.items():
        try:
            ingest_telemetry(store, device_id, soc, p, observed_at=at, source="poll", now=at)
            n += 1
        except ValueError:
            continue
    return n
