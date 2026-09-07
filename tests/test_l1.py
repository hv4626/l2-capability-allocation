from datetime import datetime, timedelta, timezone

from l0_foundation.channels import FireAndForgetBus
from l0_foundation.entities import (
    BroadcastList,
    Channel,
    Device,
    IncomingSignal,
    Site,
    ThresholdRule,
)
from l0_foundation.l1_engine import evaluate_signals_l1, sync_reserve_bound, tick_timeouts
from l0_foundation.store import Store


def _fleet(store: Store) -> None:
    store.put_site(Site("sit_a", "cust_a", "BESCOM"))
    store.put_channel(Channel("ch_relay", "relay", "gw://a"))
    store.put_channel(Channel("ch_sms", "sms", "+91000"))
    store.put_device(Device("dev_batt", "sit_a", "ch_relay", "battery", 5.0, 20.0))
    store.put_device(Device("dev_tstat", "sit_a", "ch_sms", "thermostat", 1.5, 0.0))
    store.put_list(BroadcastList("lst_peak", "peak"))
    store.add_member("lst_peak", "dev_batt")
    store.add_member("lst_peak", "dev_tstat")
    store.put_rule(
        ThresholdRule("rul_peak", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 0.5 PU")
    )


class ScriptedBus:
    def __init__(self, outcomes: list[bool | None]):
        self.outcomes = list(outcomes)
        self.attempts = []

    def send(self, channel, instruction, on_ack=None):
        self.attempts.append((channel.channel_id, instruction))
        if not self.outcomes:
            result = True
        else:
            result = self.outcomes.pop(0)
        if on_ack is not None and result is not None:
            on_ack(result)


def test_ack_completes_dispatch(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    events = evaluate_signals_l1([IncomingSignal("forecast_peak", 0.9, "sig_1")], store, bus)
    assert len(events) == 1
    msgs = store.list_messages()
    assert len(msgs) == 2
    assert all(m.status == "acked" for m in msgs)
    assert store.get_device("dev_batt").current_dispatch_state == "completed"
    assert store.get_device("dev_batt").device_status == "active"


def test_nack_retries_then_succeeds(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = ScriptedBus([False, True, True])
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.9, "sig_2")], store, bus)
    msgs = store.list_messages()
    assert any(m.attempt_number == 2 for m in msgs)
    assert store.get_device("dev_batt").current_dispatch_state == "completed"


def test_timeout_retries_then_fails(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    store.put_site(Site("sit_a", "cust_a", "BESCOM"))
    store.put_channel(Channel("ch_relay", "relay", "gw://a"))
    store.put_device(Device("dev_batt", "sit_a", "ch_relay", "battery", 5.0, 20.0))
    store.put_list(BroadcastList("lst_peak", "peak"))
    store.add_member("lst_peak", "dev_batt")
    store.put_rule(
        ThresholdRule("rul_peak", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 0.5 PU")
    )
    bus = ScriptedBus([None, None, None, None])
    t0 = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.9, "sig_to")], store, bus, now=t0)
    assert store.get_device("dev_batt").current_dispatch_state == "dispatched"
    tick_timeouts(store, bus, now=t0 + timedelta(seconds=6))
    tick_timeouts(store, bus, now=t0 + timedelta(seconds=12))
    tick_timeouts(store, bus, now=t0 + timedelta(seconds=18))
    assert store.get_device("dev_batt").current_dispatch_state == "failed"
    assert any(m.status == "timed_out" for m in store.list_messages())


def test_overlap_skips_in_flight_device(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    store.put_site(Site("sit_a", "cust_a", "BESCOM"))
    store.put_channel(Channel("ch_relay", "relay", "gw://a"))
    store.put_device(Device("dev_batt", "sit_a", "ch_relay", "battery", 5.0, 20.0))
    store.put_list(BroadcastList("lst_peak", "peak"))
    store.add_member("lst_peak", "dev_batt")
    store.put_rule(
        ThresholdRule("rul_peak", "forecast_peak", ">", 0.85, "lst_peak", "DISCHARGE 0.5 PU")
    )
    bus = ScriptedBus([None])
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.9, "sig_a")], store, bus)
    assert store.get_device("dev_batt").current_dispatch_state == "dispatched"
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.95, "sig_b")], store, bus)
    assert len(store.list_messages()) == 1


def test_ack_timeout_race_guard(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    evaluate_signals_l1([IncomingSignal("forecast_peak", 0.9, "sig_r")], store, bus)
    msg = store.list_messages()[0]
    claimed = store.update_message_if_status(msg.message_id, "pending", status="timed_out")
    assert claimed is None
    assert store.get_message(msg.message_id).status == "acked"


def test_config_sync_sets_synced(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    _fleet(store)
    bus = FireAndForgetBus()
    d = store.get_device("dev_batt")
    assert d.config_status == "unsynced"
    sync_reserve_bound(store, bus, d)
    d = store.get_device("dev_batt")
    assert d.config_status == "synced"
    assert d.config_synced_at is not None
    msgs = [m for m in store.list_messages() if m.message_type == "config_sync"]
    assert msgs[0].payload == "20.0"


def test_new_device_defaults_are_l1_safe(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    store.put_site(Site("sit_a", "cust_a", "BESCOM"))
    store.put_channel(Channel("ch_relay", "relay", "gw://a"))
    d = store.put_device(Device("dev_x", "sit_a", "ch_relay", "battery", 1.0, 10.0))
    assert d.current_dispatch_state == "idle"
    assert d.config_status == "unsynced"
    assert d.config_synced_at is None
    assert d.device_status == "active"
