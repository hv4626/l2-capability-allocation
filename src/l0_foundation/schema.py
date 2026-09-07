"""SQLAlchemy tables — L0/L1 plus L2 capability, telemetry, solver, reservations."""

from __future__ import annotations

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class SiteRow(Base):
    __tablename__ = "site"

    site_id: Mapped[str] = mapped_column(String, primary_key=True)
    customer_id: Mapped[str] = mapped_column(String, nullable=False)
    utility_territory: Mapped[str] = mapped_column(String, nullable=False)
    contract_floor_soc_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    export_limit_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    import_limit_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    site_headroom_source: Mapped[str] = mapped_column(String, nullable=False, default="assumed_default")

    devices: Mapped[list[DeviceRow]] = relationship(back_populates="site")


class ChannelRow(Base):
    __tablename__ = "channel"

    channel_id: Mapped[str] = mapped_column(String, primary_key=True)
    channel_type: Mapped[str] = mapped_column(String, nullable=False)
    endpoint: Mapped[str] = mapped_column(String, nullable=False)

    devices: Mapped[list[DeviceRow]] = relationship(back_populates="channel")


class DeviceRow(Base):
    __tablename__ = "device"

    device_id: Mapped[str] = mapped_column(String, primary_key=True)
    site_id: Mapped[str] = mapped_column(ForeignKey("site.site_id"), nullable=False)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channel.channel_id"), nullable=False)
    device_class: Mapped[str] = mapped_column(String, nullable=False)
    rated_capacity_kw: Mapped[float] = mapped_column(Float, nullable=False)
    reserve_bound_pct: Mapped[float] = mapped_column(Float, nullable=False)
    device_status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    current_dispatch_state: Mapped[str] = mapped_column(String, nullable=False, default="idle")
    config_status: Mapped[str] = mapped_column(String, nullable=False, default="unsynced")
    config_synced_at: Mapped[object | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_soc_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_p_ac_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_telemetry_at: Mapped[object | None] = mapped_column(DateTime(timezone=True), nullable=True)
    opt_out_until: Mapped[object | None] = mapped_column(DateTime(timezone=True), nullable=True)

    site: Mapped[SiteRow] = relationship(back_populates="devices")
    channel: Mapped[ChannelRow] = relationship(back_populates="devices")
    memberships: Mapped[list[ListMembershipRow]] = relationship(back_populates="device")
    messages: Mapped[list["ChannelMessageRow"]] = relationship(back_populates="device")
    capability: Mapped[DeviceCapabilityRow | None] = relationship(back_populates="device")


class BroadcastListRow(Base):
    __tablename__ = "broadcast_list"

    list_id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)

    memberships: Mapped[list[ListMembershipRow]] = relationship(back_populates="broadcast_list")
    rules: Mapped[list[ThresholdRuleRow]] = relationship(back_populates="broadcast_list")


class ListMembershipRow(Base):
    __tablename__ = "list_membership"
    __table_args__ = (UniqueConstraint("device_id", "list_id", name="uq_list_member"),)

    device_id: Mapped[str] = mapped_column(ForeignKey("device.device_id"), primary_key=True)
    list_id: Mapped[str] = mapped_column(ForeignKey("broadcast_list.list_id"), primary_key=True)

    device: Mapped[DeviceRow] = relationship(back_populates="memberships")
    broadcast_list: Mapped[BroadcastListRow] = relationship(back_populates="memberships")


class ThresholdRuleRow(Base):
    __tablename__ = "threshold_rule"

    rule_id: Mapped[str] = mapped_column(String, primary_key=True)
    signal_source: Mapped[str] = mapped_column(String, nullable=False)
    comparator: Mapped[str] = mapped_column(String, nullable=False)
    threshold_value: Mapped[float] = mapped_column(Float, nullable=False)
    list_id: Mapped[str] = mapped_column(ForeignKey("broadcast_list.list_id"), nullable=False)
    fixed_instruction: Mapped[str] = mapped_column(String, nullable=False, default="")
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    instruction_type: Mapped[str] = mapped_column(String, nullable=False, default="fixed")
    target_kw: Mapped[float | None] = mapped_column(Float, nullable=True)
    duration_min: Mapped[int | None] = mapped_column(Integer, nullable=True)

    broadcast_list: Mapped[BroadcastListRow] = relationship(back_populates="rules")
    events: Mapped[list[DispatchLogRow]] = relationship(back_populates="rule")


class DispatchLogRow(Base):
    __tablename__ = "dispatch_log"
    __table_args__ = (UniqueConstraint("rule_id", "signal_id", name="uq_dispatch_rule_signal"),)

    event_id: Mapped[str] = mapped_column(String, primary_key=True)
    rule_id: Mapped[str] = mapped_column(ForeignKey("threshold_rule.rule_id"), nullable=False)
    triggered_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    instruction_text: Mapped[str] = mapped_column(String, nullable=False)
    signal_id: Mapped[str] = mapped_column(String, nullable=False, default="")

    rule: Mapped[ThresholdRuleRow] = relationship(back_populates="events")
    messages: Mapped[list["ChannelMessageRow"]] = relationship(back_populates="event")
    solver_runs: Mapped[list["SolverRunRow"]] = relationship(back_populates="event")


class ChannelMessageRow(Base):
    __tablename__ = "channel_message"

    message_id: Mapped[str] = mapped_column(String, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("device.device_id"), nullable=False)
    event_id: Mapped[str | None] = mapped_column(ForeignKey("dispatch_log.event_id"), nullable=True)
    message_type: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    sent_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    ack_at: Mapped[object | None] = mapped_column(DateTime(timezone=True), nullable=True)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    retry_of_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("channel_message.message_id"), nullable=True
    )
    allocation_id: Mapped[str | None] = mapped_column(
        ForeignKey("device_allocation.allocation_id"), nullable=True
    )

    device: Mapped[DeviceRow] = relationship(back_populates="messages")
    event: Mapped[DispatchLogRow | None] = relationship(back_populates="messages")


class DeviceCapabilityRow(Base):
    __tablename__ = "device_capability"

    device_id: Mapped[str] = mapped_column(ForeignKey("device.device_id"), primary_key=True)
    energy_capacity_kwh: Mapped[float] = mapped_column(Float, nullable=False)
    p_discharge_max_kw: Mapped[float] = mapped_column(Float, nullable=False)
    p_charge_max_kw: Mapped[float] = mapped_column(Float, nullable=False)
    eta_discharge: Mapped[float] = mapped_column(Float, nullable=False)
    eta_charge: Mapped[float] = mapped_column(Float, nullable=False)
    soc_min_pct: Mapped[float] = mapped_column(Float, nullable=False)
    soc_max_pct: Mapped[float] = mapped_column(Float, nullable=False)
    control_mode: Mapped[str] = mapped_column(String, nullable=False, default="continuous")
    setpoint_step_kw: Mapped[float] = mapped_column(Float, nullable=False, default=0.1)
    capability_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    device: Mapped[DeviceRow] = relationship(back_populates="capability")


class TelemetrySampleRow(Base):
    __tablename__ = "telemetry_sample"

    sample_id: Mapped[str] = mapped_column(String, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("device.device_id"), nullable=False)
    observed_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    ingested_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    soc_pct: Mapped[float] = mapped_column(Float, nullable=False)
    p_ac_kw: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False, default="manual")


class SolverRunRow(Base):
    __tablename__ = "solver_run"

    run_id: Mapped[str] = mapped_column(String, primary_key=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("dispatch_log.event_id"), nullable=False)
    run_number: Mapped[int] = mapped_column(Integer, nullable=False)
    solved_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    telemetry_cutoff_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    target_kw: Mapped[float] = mapped_column(Float, nullable=False)
    eligible_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_headroom_kw: Mapped[float] = mapped_column(Float, nullable=False)
    allocated_kw: Mapped[float] = mapped_column(Float, nullable=False)
    shortfall_kw: Mapped[float] = mapped_column(Float, nullable=False)
    lam: Mapped[float] = mapped_column("lambda", Float, nullable=False)
    sites_binding_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quantization_loss_kw: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String, nullable=False)

    event: Mapped[DispatchLogRow] = relationship(back_populates="solver_runs")
    allocations: Mapped[list["DeviceAllocationRow"]] = relationship(back_populates="run")


class DeviceAllocationRow(Base):
    __tablename__ = "device_allocation"
    __table_args__ = (UniqueConstraint("run_id", "device_id", name="uq_run_device"),)

    allocation_id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("solver_run.run_id"), nullable=False)
    device_id: Mapped[str] = mapped_column(ForeignKey("device.device_id"), nullable=False)
    capability_version: Mapped[int] = mapped_column(Integer, nullable=False)
    soc_at_solve_pct: Mapped[float] = mapped_column(Float, nullable=False)
    floor_soc_pct: Mapped[float] = mapped_column(Float, nullable=False)
    headroom_kw: Mapped[float] = mapped_column(Float, nullable=False)
    p_setpoint_kw: Mapped[float] = mapped_column(Float, nullable=False)
    p_setpoint_raw_kw: Mapped[float] = mapped_column(Float, nullable=False)
    expected_energy_kwh: Mapped[float] = mapped_column(Float, nullable=False)
    binding_constraint: Mapped[str] = mapped_column(String, nullable=False)
    delivered_kwh: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False)

    run: Mapped[SolverRunRow] = relationship(back_populates="allocations")


class HeadroomReservationRow(Base):
    __tablename__ = "headroom_reservation"

    reservation_id: Mapped[str] = mapped_column(String, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("device.device_id"), nullable=False)
    site_id: Mapped[str] = mapped_column(ForeignKey("site.site_id"), nullable=False)
    run_id: Mapped[str] = mapped_column(ForeignKey("solver_run.run_id"), nullable=False)
    allocation_id: Mapped[str | None] = mapped_column(
        ForeignKey("device_allocation.allocation_id"), nullable=True
    )
    reserved_kw: Mapped[float] = mapped_column(Float, nullable=False)
    reserved_energy_kwh: Mapped[float] = mapped_column(Float, nullable=False)
    held_from: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    held_until: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
