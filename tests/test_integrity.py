from fastapi.testclient import TestClient

from l0_foundation.api import app, configure
from l0_foundation.channels import FireAndForgetBus
from l0_foundation.store import Store


def test_cannot_delete_rule_after_it_has_fired(tmp_path):
    configure(Store(f"sqlite:///{tmp_path / 't.sqlite'}"), FireAndForgetBus())
    c = TestClient(app)
    assert c.post("/api/seed").status_code == 200
    fired = c.post("/api/signals", json={"source": "forecast_peak", "value": 0.9})
    assert fired.status_code == 200
    assert fired.json()["fired_event_ids"]
    blocked = c.delete("/api/rules/rul_forecast_peak")
    assert blocked.status_code == 409
    assert "dispatch log" in blocked.json()["detail"]
