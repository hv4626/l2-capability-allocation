from l0_foundation.schema import (
    BroadcastListRow,
    ChannelRow,
    DeviceRow,
    DispatchLogRow,
    ListMembershipRow,
    SiteRow,
    ThresholdRuleRow,
)
from l0_foundation.store import Store


L0_TABLES = {
    "site",
    "channel",
    "device",
    "broadcast_list",
    "list_membership",
    "threshold_rule",
    "dispatch_log",
    "channel_message",
    "device_capability",
    "telemetry_sample",
    "solver_run",
    "device_allocation",
    "headroom_reservation",
}


def test_only_spec_tables():
    names = set(SiteRow.metadata.tables)
    assert names == L0_TABLES


def test_device_columns():
    cols = set(DeviceRow.__table__.columns.keys())
    assert cols == {
        "device_id",
        "site_id",
        "channel_id",
        "device_class",
        "rated_capacity_kw",
        "reserve_bound_pct",
        "device_status",
        "current_dispatch_state",
        "config_status",
        "config_synced_at",
        "last_soc_pct",
        "last_p_ac_kw",
        "last_telemetry_at",
        "opt_out_until",
    }
    assert "ack_status" not in cols
    assert "dispatch_status" not in cols
    assert "capacity_available" not in cols


def test_dispatch_log_has_no_per_device_outcome():
    cols = set(DispatchLogRow.__table__.columns.keys())
    assert cols == {"event_id", "rule_id", "triggered_at", "instruction_text", "signal_id"}
    assert "device_id" not in cols
    assert "ack_status" not in cols
    names = {c.name for c in DispatchLogRow.__table__.constraints}
    assert "uq_dispatch_rule_signal" in names


def test_rule_priority_and_active():
    cols = set(ThresholdRuleRow.__table__.columns.keys())
    assert "priority" in cols
    assert "is_active" in cols


def test_foreign_keys():
    device_fks = {fk.target_fullname for fk in DeviceRow.__table__.foreign_keys}
    assert device_fks == {"site.site_id", "channel.channel_id"}
    member_fks = {fk.target_fullname for fk in ListMembershipRow.__table__.foreign_keys}
    assert member_fks == {"device.device_id", "broadcast_list.list_id"}
    rule_fks = {fk.target_fullname for fk in ThresholdRuleRow.__table__.foreign_keys}
    assert rule_fks == {"broadcast_list.list_id"}
    log_fks = {fk.target_fullname for fk in DispatchLogRow.__table__.foreign_keys}
    assert log_fks == {"threshold_rule.rule_id"}


def test_site_and_channel_columns():
    assert set(SiteRow.__table__.columns.keys()) == {
        "site_id",
        "customer_id",
        "utility_territory",
        "contract_floor_soc_pct",
        "export_limit_kw",
        "import_limit_kw",
        "site_headroom_source",
    }
    assert set(ChannelRow.__table__.columns.keys()) == {
        "channel_id",
        "channel_type",
        "endpoint",
    }


def test_sqlite_roundtrip(tmp_path):
    store = Store(f"sqlite:///{tmp_path / 't.sqlite'}")
    from l0_foundation.entities import Channel, Site

    store.put_site(Site("sit_x", "cust_x", "BESCOM"))
    store.put_channel(Channel("ch_x", "api", "https://example/x"))
    assert store.list_sites()[0].utility_territory == "BESCOM"
    assert store.get_channel("ch_x").channel_type == "api"
