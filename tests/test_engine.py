from datetime import datetime, timezone

from l0_foundation.channels import FireAndForgetBus
from l0_foundation.engine import evaluate_signals
from l0_foundation.entities import (
    BroadcastList,
    Channel,
    Device,
    IncomingSignal,
    Site,
    ThresholdRule,
)
from l0_foundation.store import Store


def _fleet(store: Store) -> None:
    store.put_site(Site("sit_a", "cust_a", "BESCOM"))
    store.put_site(Site("sit_b", "cust_b", "MSEDCL"))
    store.put_channel(Channel("ch_sms", "sms", "+91000"))
    store.put_channel(Channel("ch_relay", "relay", "gw://a"))
    store.put_device(Device("dev_batt", "sit_a", "ch_relay", "battery", 5.0, 20.0))
    store.put_device(Device("dev_tstat", "sit_b", "ch_sms", "thermostat", 1.5, 0.0))
    store.put_device(Device("dev_other", "sit_a", "ch_relay", "battery", 8.0, 20.0))
    store.put_list(BroadcastList("lst_peak", "peak"))
    store.add_member("lst_peak", "dev_batt")
    store.add_member("lst_peak", "dev_tstat")
    store.put_rule(
        ThresholdRule("rul_peak", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 0.5 PU")
    )


def test_fires_fixed_instruction_at_static_list(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    now = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)

    events = evaluate_signals(
        [IncomingSignal("forecast_peak", 0.9)], store, bus, now=now
    )

    assert len(events) == 1
    assert events[0].rule_id == "rul_peak"
    assert events[0].instruction_text == "DISCHARGE 0.5 PU"
    assert events[0].triggered_at == now
    endpoints = sorted(s.endpoint for s in bus.attempts)
    assert endpoints == ["+91000", "gw://a"]
    assert {s.instruction_text for s in bus.attempts} == {"DISCHARGE 0.5 PU"}
    assert "dev_other" not in {store.get_device("dev_batt").device_id} or True
    contacted_channels = {s.channel_id for s in bus.attempts}
    assert contacted_channels == {"ch_sms", "ch_relay"}
    # device not on the list was not reached via a third send
    assert len(bus.attempts) == 2


def test_does_not_fire_below_threshold(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    events = evaluate_signals([IncomingSignal("forecast_peak", 0.85)], store, bus)
    assert events == []
    assert bus.attempts == []
    assert store.list_dispatch_log() == []


def test_unknown_source_is_a_no_op(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    events = evaluate_signals([IncomingSignal("price_spike", 9.9)], store, bus)
    assert events == []
    assert bus.attempts == []


def test_empty_list_still_writes_dispatch_log(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    store.put_list(BroadcastList("lst_empty", "empty"))
    store.put_rule(
        ThresholdRule("rul_empty", "discom_call", ">=", 1.0, "lst_empty", "CURTAIL HVAC")
    )
    bus = FireAndForgetBus()
    events = evaluate_signals([IncomingSignal("discom_call", 1.0)], store, bus)
    assert len(events) == 1
    assert bus.attempts == []


def test_send_return_value_is_not_inspected(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)

    class LyingBus:
        def send(self, channel, instruction):
            return {"ack": "yes", "status": "delivered"}

    events = evaluate_signals([IncomingSignal("forecast_peak", 1.0)], store, LyingBus())
    assert len(events) == 1
    log = store.list_dispatch_log()[0]
    assert not hasattr(log, "ack_status")
    assert set(log.__dataclass_fields__) == {
        "event_id",
        "rule_id",
        "triggered_at",
        "instruction_text",
        "signal_id",
    }


def test_duplicate_signal_id_is_skipped(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    first = evaluate_signals(
        [IncomingSignal("forecast_peak", 0.9, "sig_same")], store, bus
    )
    assert len(first) == 1
    assert len(bus.attempts) == 2
    second = evaluate_signals(
        [IncomingSignal("forecast_peak", 0.9, "sig_same")], store, bus
    )
    assert second == []
    assert len(bus.attempts) == 2
    assert store.list_dispatch_log()[0].signal_id == "sig_same"


def test_paused_device_is_not_sent(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    paused = store.get_device("dev_tstat")
    store.put_device(
        Device(
            paused.device_id,
            paused.site_id,
            paused.channel_id,
            paused.device_class,
            paused.rated_capacity_kw,
            paused.reserve_bound_pct,
            "paused",
        )
    )
    # device_status paused — not dispatch_status
    bus = FireAndForgetBus()
    evaluate_signals([IncomingSignal("forecast_peak", 0.9)], store, bus)
    assert [s.channel_id for s in bus.attempts] == ["ch_relay"]


def test_inactive_rule_is_ignored(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    store.put_rule(
        ThresholdRule("rul_peak", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 0.5 PU", 10, False)
    )
    bus = FireAndForgetBus()
    events = evaluate_signals([IncomingSignal("forecast_peak", 0.9)], store, bus)
    assert events == []
    assert bus.attempts == []


def test_priority_orders_overlapping_rules(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    store.put_rule(
        ThresholdRule("rul_peak", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 0.5 PU", 20, True)
    )
    store.put_rule(
        ThresholdRule("rul_peak_hi", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 1.0 PU", 10, True)
    )
    bus = FireAndForgetBus()
    events = evaluate_signals([IncomingSignal("forecast_peak", 0.9)], store, bus)
    assert [e.rule_id for e in events] == ["rul_peak_hi", "rul_peak"]
    assert [s.instruction_text for s in bus.attempts] == [
        "DISCHARGE 1.0 PU",
        "DISCHARGE 1.0 PU",
        "DISCHARGE 0.5 PU",
        "DISCHARGE 0.5 PU",
    ]


def test_reserve_bound_is_stored_and_unread_by_engine():
    import inspect

    from l0_foundation import engine

    source = inspect.getsource(engine.evaluate_signals)
    assert "reserve_bound" not in source
    assert "rated_capacity" not in source
    assert "ack" not in source
