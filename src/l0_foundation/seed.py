"""A generic demo fleet. No vendor or company assumptions."""

from __future__ import annotations

from l0_foundation.entities import BroadcastList, Channel, Device, DeviceCapability, Site, ThresholdRule
from l0_foundation.store import Store


def seed(store: Store) -> None:
    sites = [
        Site(
            "sit_jayanagar",
            "cust_ramesh",
            "BESCOM",
            contract_floor_soc_pct=10.0,
            export_limit_kw=4.0,
            import_limit_kw=5.0,
            site_headroom_source="measured",
        ),
        Site(
            "sit_koramangala",
            "cust_nair",
            "BESCOM",
            contract_floor_soc_pct=10.0,
            export_limit_kw=20.0,
            import_limit_kw=20.0,
            site_headroom_source="nameplate",
        ),
        Site(
            "sit_andheri",
            "cust_mehta",
            "MSEDCL",
            contract_floor_soc_pct=12.0,
            export_limit_kw=15.0,
            import_limit_kw=15.0,
            site_headroom_source="measured",
        ),
        Site(
            "sit_pune",
            "cust_deshmukh",
            "MSEDCL",
            contract_floor_soc_pct=15.0,
            export_limit_kw=8.0,
            import_limit_kw=8.0,
            site_headroom_source="assumed_default",
        ),
        Site(
            "sit_adyar",
            "cust_iyer",
            "TANGEDCO",
            contract_floor_soc_pct=10.0,
            export_limit_kw=None,
            import_limit_kw=None,
            site_headroom_source="assumed_default",
        ),
    ]
    channels = [
        Channel("ch_relay_jayanagar", "relay", "gw://jayanagar-ven"),
        Channel("ch_sms_nair", "sms", "+919876543210"),
        Channel("ch_api_andheri", "api", "https://ven.example/andheri"),
        Channel("ch_phone_pune", "phone", "+912022334455"),
        Channel("ch_relay_adyar", "relay", "gw://adyar-ven"),
        Channel("ch_sms_jayanagar", "sms", "+919811122233"),
    ]
    devices = [
        Device("dev_jay_batt", "sit_jayanagar", "ch_relay_jayanagar", "battery", 5.0, 20.0),
        Device("dev_jay_tstat", "sit_jayanagar", "ch_sms_jayanagar", "thermostat", 1.5, 0.0),
        Device("dev_kora_batt", "sit_koramangala", "ch_sms_nair", "battery", 10.0, 15.0),
        Device("dev_and_batt", "sit_andheri", "ch_api_andheri", "battery", 7.5, 20.0),
        Device("dev_and_tstat", "sit_andheri", "ch_api_andheri", "thermostat", 2.0, 0.0),
        Device("dev_pune_batt", "sit_pune", "ch_phone_pune", "battery", 5.0, 25.0),
        Device("dev_ady_batt", "sit_adyar", "ch_relay_adyar", "battery", 12.0, 20.0),
        Device("dev_ady_tstat", "sit_adyar", "ch_relay_adyar", "thermostat", 1.8, 0.0),
    ]
    capabilities = [
        DeviceCapability("dev_jay_batt", 10.0, 5.0, 5.0, 0.95, 0.95, 5.0, 95.0, "continuous", 0.1, 1),
        DeviceCapability("dev_kora_batt", 20.0, 10.0, 10.0, 0.95, 0.95, 5.0, 95.0, "continuous", 0.1, 1),
        DeviceCapability("dev_and_batt", 15.0, 7.5, 7.5, 0.94, 0.94, 5.0, 95.0, "continuous", 0.1, 1),
        DeviceCapability("dev_pune_batt", 10.0, 5.0, 5.0, 0.93, 0.93, 5.0, 95.0, "continuous", 0.1, 1),
        DeviceCapability("dev_ady_batt", 24.0, 12.0, 12.0, 0.95, 0.95, 5.0, 95.0, "continuous", 0.1, 1),
    ]
    lists = [
        BroadcastList("lst_peak_batteries", "Peak-shave batteries"),
        BroadcastList("lst_hvac", "HVAC curtailment"),
    ]
    membership = {
        "lst_peak_batteries": [
            "dev_jay_batt",
            "dev_kora_batt",
            "dev_and_batt",
            "dev_pune_batt",
            "dev_ady_batt",
        ],
        "lst_hvac": ["dev_jay_tstat", "dev_and_tstat", "dev_ady_tstat"],
    }
    rules = [
        ThresholdRule(
            rule_id="rul_forecast_peak",
            signal_source="forecast_peak",
            comparator=">",
            threshold_value=0.85,
            list_id="lst_peak_batteries",
            fixed_instruction="",
            priority=10,
            is_active=True,
            instruction_type="fleet_target",
            target_kw=15.0,
            duration_min=30,
        ),
        ThresholdRule(
            rule_id="rul_discom_call",
            signal_source="discom_call",
            comparator=">=",
            threshold_value=1.0,
            list_id="lst_hvac",
            fixed_instruction="CURTAIL HVAC",
            priority=20,
            is_active=True,
            instruction_type="fixed",
        ),
    ]

    for site in sites:
        store.put_site(site)
    for channel in channels:
        store.put_channel(channel)
    for device in devices:
        store.put_device(device)
    for cap in capabilities:
        store.put_capability(cap)
    for broadcast_list in lists:
        store.put_list(broadcast_list)
    for list_id, device_ids in membership.items():
        for device_id in device_ids:
            store.add_member(list_id, device_id)
    for rule in rules:
        store.put_rule(rule)
