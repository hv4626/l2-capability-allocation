from datetime import datetime, timezone

from l0_foundation.channels import FireAndForgetBus
from l0_foundation.entities import IncomingSignal
from l0_foundation.l1_engine import evaluate_signals_l1, sync_all_unsynced
from l0_foundation.l2_engine import ingest_telemetry, release_event, seed_telemetry_now
from l0_foundation.l2_solver import DeviceQP, solve_qp
from l0_foundation.seed import seed
from l0_foundation.store import Store


def test_equal_stress_closed_form():
    devices = [
        DeviceQP("a", "s1", pbar=10, c=0.1, step=0.1, binary=False),
        DeviceQP("b", "s2", pbar=5, c=0.2, step=0.1, binary=False),
    ]
    g = {"s1": float("inf"), "s2": float("inf")}
    result = solve_qp(7.5, devices, g)
    # λ = R / Σp̄ = 0.5 → p = 0.5 * pbar
    assert abs(result.p["a"] - 5.0) < 0.05
    assert abs(result.p["b"] - 2.5) < 0.05
    assert result.shortfall < 0.05


def test_site_cap_binds():
    devices = [
        DeviceQP("a", "s1", pbar=10, c=0.1, step=0.1, binary=False),
        DeviceQP("b", "s1", pbar=10, c=0.1, step=0.1, binary=False),
    ]
    result = solve_qp(20, devices, {"s1": 6.0})
    assert abs(sum(result.p.values()) - 6.0) < 0.15
    assert result.sites_binding >= 1


def test_allocation_after_sync_and_telemetry(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    seed(store)
    bus = FireAndForgetBus()
    t0 = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    sync_all_unsynced(store, bus)
    seed_telemetry_now(store, now=t0)
    events = evaluate_signals_l1(
        [IncomingSignal("forecast_peak", 0.91, "sig_peak")], store, bus, now=t0
    )
    assert len(events) == 1
    runs = store.list_solver_runs(events[0].event_id)
    assert runs
    assert runs[0].status in ("optimal", "degraded")
    allocs = store.list_allocations(events[0].event_id)
    assert allocs
    total = sum(a.p_setpoint_kw for a in allocs)
    assert total > 0
    assert total <= 15.2
    jay = next((a for a in allocs if a.device_id == "dev_jay_batt"), None)
    if jay:
        assert jay.p_setpoint_kw <= 4.0 + 0.11  # site export cap 4 kW


def test_stale_telemetry_excluded(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    seed(store)
    bus = FireAndForgetBus()
    t0 = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    sync_all_unsynced(store, bus)
    stale = t0.replace(hour=12)
    ingest_telemetry(store, "dev_jay_batt", 80, 0, observed_at=stale, now=t0)
    seed_telemetry_now(store, now=t0)
    # overwrite jay with stale
    ingest_telemetry(store, "dev_jay_batt", 80, 0, observed_at=stale, now=t0)
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.91, "sig_stale")], store, bus, now=t0)
    allocs = store.list_allocations()
    assert all(a.device_id != "dev_jay_batt" for a in allocs)


def test_opt_out_excludes_device(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    seed(store)
    bus = FireAndForgetBus()
    t0 = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    sync_all_unsynced(store, bus)
    seed_telemetry_now(store, now=t0)
    d = store.get_device("dev_kora_batt")
    store.put_device(
        d.__class__(
            **{**d.__dict__, "opt_out_until": t0.replace(hour=23)}
        )
    )
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.91, "sig_opt")], store, bus, now=t0)
    assert all(a.device_id != "dev_kora_batt" for a in store.list_allocations())


def test_second_event_sees_reservations(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    seed(store)
    bus = FireAndForgetBus()
    t0 = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    sync_all_unsynced(store, bus)
    seed_telemetry_now(store, now=t0)
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.91, "sig_a")], store, bus, now=t0)
    h1 = store.list_solver_runs()[0].total_headroom_kw
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.92, "sig_b")], store, bus, now=t0)
    runs = sorted(store.list_solver_runs(), key=lambda r: r.solved_at)
    assert len(runs) >= 2
    # overlapping hold reduces remaining headroom for the second solve
    assert runs[-1].total_headroom_kw < h1 - 1.0


def test_charge_target_negative(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    seed(store)
    bus = FireAndForgetBus()
    t0 = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    sync_all_unsynced(store, bus)
    seed_telemetry_now(store, now=t0)
    rule = store.get_rule("rul_forecast_peak")
    store.put_rule(
        rule.__class__(
            **{**rule.__dict__, "target_kw": -8.0}
        )
    )
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.91, "sig_chg")], store, bus, now=t0)
    allocs = store.list_allocations()
    assert allocs
    assert all(a.p_setpoint_kw <= 0 for a in allocs)


def test_release_frees_reservations(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    seed(store)
    bus = FireAndForgetBus()
    t0 = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)
    sync_all_unsynced(store, bus)
    seed_telemetry_now(store, now=t0)
    events = evaluate_signals_l1(
        [IncomingSignal("forecast_peak", 0.91, "sig_rel")], store, bus, now=t0
    )
    live = [r for r in store.list_reservations() if r.status in ("held", "committed")]
    assert live
    release_event(store, bus, events[0].event_id, reason="event_cancelled", now=t0)
    live = [r for r in store.list_reservations() if r.status in ("held", "committed")]
    assert live == []
