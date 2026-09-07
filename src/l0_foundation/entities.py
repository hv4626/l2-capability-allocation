"""L0/L1 entities plus L2 capability, telemetry, allocation, and reservations."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

DEVICE_ACTIVE = "active"
DEVICE_PAUSED = "paused"
DEVICE_DECOMMISSIONED = "decommissioned"
DEVICE_STATUSES = (DEVICE_ACTIVE, DEVICE_PAUSED, DEVICE_DECOMMISSIONED)


@dataclass(frozen=True)
class Site:
    site_id: str
    customer_id: str
    utility_territory: str
    contract_floor_soc_pct: float | None = None
    export_limit_kw: float | None = None
    import_limit_kw: float | None = None
    site_headroom_source: str = "assumed_default"


@dataclass(frozen=True)
class Channel:
    channel_id: str
    channel_type: str
    endpoint: str


@dataclass(frozen=True)
class Device:
    device_id: str
    site_id: str
    channel_id: str
    device_class: str
    rated_capacity_kw: float
    reserve_bound_pct: float
    device_status: str = DEVICE_ACTIVE
    current_dispatch_state: str = "idle"
    config_status: str = "unsynced"
    config_synced_at: datetime | None = None
    last_soc_pct: float | None = None
    last_p_ac_kw: float | None = None
    last_telemetry_at: datetime | None = None
    opt_out_until: datetime | None = None


@dataclass(frozen=True)
class BroadcastList:
    list_id: str
    name: str


@dataclass(frozen=True)
class ListMembership:
    device_id: str
    list_id: str


@dataclass(frozen=True)
class ThresholdRule:
    rule_id: str
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


@dataclass(frozen=True)
class DispatchLog:
    event_id: str
    rule_id: str
    triggered_at: datetime
    instruction_text: str
    signal_id: str = ""


@dataclass(frozen=True)
class IncomingSignal:
    source: str
    value: float
    signal_id: str = ""


DISPATCH_STATES = ("idle", "dispatched", "completed", "failed")
CONFIG_STATUSES = ("unsynced", "pending", "synced", "stale", "failed")
MESSAGE_TYPES = ("dispatch_instruction", "config_sync", "setpoint_revision", "release")
MESSAGE_STATUSES = ("pending", "acked", "nacked", "timed_out")


@dataclass(frozen=True)
class ChannelMessage:
    message_id: str
    device_id: str
    event_id: str | None
    message_type: str
    payload: str
    status: str
    sent_at: datetime
    ack_at: datetime | None
    timeout_seconds: int
    attempt_number: int
    retry_of_message_id: str | None
    allocation_id: str | None = None


@dataclass(frozen=True)
class DeviceCapability:
    device_id: str
    energy_capacity_kwh: float
    p_discharge_max_kw: float
    p_charge_max_kw: float
    eta_discharge: float
    eta_charge: float
    soc_min_pct: float
    soc_max_pct: float
    control_mode: str = "continuous"
    setpoint_step_kw: float = 0.1
    capability_version: int = 1


@dataclass(frozen=True)
class TelemetrySample:
    sample_id: str
    device_id: str
    observed_at: datetime
    ingested_at: datetime
    soc_pct: float
    p_ac_kw: float
    source: str = "manual"


@dataclass(frozen=True)
class HeadroomReservation:
    reservation_id: str
    device_id: str
    site_id: str
    run_id: str
    reserved_kw: float
    reserved_energy_kwh: float
    held_from: datetime
    held_until: datetime
    status: str
    allocation_id: str | None = None


@dataclass(frozen=True)
class SolverRun:
    run_id: str
    event_id: str
    run_number: int
    solved_at: datetime
    telemetry_cutoff_at: datetime
    target_kw: float
    eligible_count: int
    total_headroom_kw: float
    allocated_kw: float
    shortfall_kw: float
    lam: float
    sites_binding_count: int
    quantization_loss_kw: float
    status: str


@dataclass(frozen=True)
class DeviceAllocation:
    allocation_id: str
    run_id: str
    device_id: str
    capability_version: int
    soc_at_solve_pct: float
    floor_soc_pct: float
    headroom_kw: float
    p_setpoint_kw: float
    p_setpoint_raw_kw: float
    expected_energy_kwh: float
    binding_constraint: str
    status: str
    delivered_kwh: float | None = None
