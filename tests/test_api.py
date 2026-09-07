from fastapi.testclient import TestClient

from l0_foundation.api import app, configure
from l0_foundation.channels import FireAndForgetBus
from l0_foundation.seed import seed
from l0_foundation.store import Store


def client(tmp_path) -> TestClient:
    configure(Store(f"sqlite:///{tmp_path / 'api.sqlite'}"), FireAndForgetBus())
    return TestClient(app)


def test_health(tmp_path):
    r = client(tmp_path).get("/api/health")
    assert r.status_code == 200
    assert r.json()["layer"] == "L2"


def test_seed_and_signal_loop(tmp_path):
    c = client(tmp_path)
    seed_r = c.post("/api/seed")
    assert seed_r.status_code == 200
    snap = seed_r.json()
    assert len(snap["devices"]) == 8
    assert "ack_status" not in snap["devices"][0]
    assert "reserve_bound_pct" in snap["devices"][0]

    miss = c.post("/api/signals", json={"source": "forecast_peak", "value": 0.85})
    assert miss.json()["fired_event_ids"] == []

    c.post("/api/config-sync")
    c.post("/api/telemetry/seed")
    hit = c.post("/api/signals", json={"source": "forecast_peak", "value": 0.9})
    body = hit.json()
    assert len(body["fired_event_ids"]) == 1
    peak = next(t for t in body["trace"] if t["rule_id"] == "rul_forecast_peak")
    assert peak["crossed"] is True
    log = body["dispatch_log"][0]
    assert set(log) == {"event_id", "rule_id", "triggered_at", "instruction_text", "signal_id"}
    assert "device_id" not in log
    assert body["signal"]["signal_id"]
    assert log["signal_id"] == body["signal"]["signal_id"]
    assert body["skipped_duplicate"] is False
    snap = c.get("/api/snapshot").json()
    assert snap["solver_runs"]
    assert snap["allocations"]
    allocated = sum(abs(a["p_setpoint_kw"]) for a in snap["allocations"])
    assert allocated > 0
    assert allocated <= 15.0 + 0.2

    again = c.post(
        "/api/signals",
        json={"source": "forecast_peak", "value": 0.9, "signal_id": body["signal"]["signal_id"]},
    )
    assert again.json()["skipped_duplicate"] is True
    assert again.json()["fired_event_ids"] == []


def test_create_device_requires_existing_site(tmp_path):
    c = client(tmp_path)
    r = c.post(
        "/api/devices",
        json={
            "site_id": "missing",
            "channel_id": "missing",
            "device_class": "battery",
            "rated_capacity_kw": 1,
            "reserve_bound_pct": 20,
        },
    )
    assert r.status_code == 400
