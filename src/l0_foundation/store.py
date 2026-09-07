from __future__ import annotations

from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, delete, event, select
from sqlalchemy.orm import Session, sessionmaker

from l0_foundation.entities import (
    BroadcastList,
    Channel,
    ChannelMessage,
    Device,
    DeviceAllocation,
    DeviceCapability,
    DispatchLog,
    HeadroomReservation,
    ListMembership,
    Site,
    SolverRun,
    TelemetrySample,
    ThresholdRule,
)
from l0_foundation.ids import new_id
from l0_foundation.schema import (
    Base,
    BroadcastListRow,
    ChannelRow,
    ChannelMessageRow,
    DeviceAllocationRow,
    DeviceCapabilityRow,
    DeviceRow,
    DispatchLogRow,
    HeadroomReservationRow,
    ListMembershipRow,
    SiteRow,
    SolverRunRow,
    TelemetrySampleRow,
    ThresholdRuleRow,
)


def _migrate_sqlite(engine) -> None:
    if engine.dialect.name != "sqlite":
        return
    alters = (
        ("device", "device_status", "VARCHAR NOT NULL DEFAULT 'active'"),
        ("threshold_rule", "priority", "INTEGER NOT NULL DEFAULT 100"),
        ("threshold_rule", "is_active", "BOOLEAN NOT NULL DEFAULT 1"),
        ("dispatch_log", "signal_id", "VARCHAR NOT NULL DEFAULT ''"),
        ("device", "current_dispatch_state", "VARCHAR NOT NULL DEFAULT 'idle'"),
        ("device", "config_status", "VARCHAR NOT NULL DEFAULT 'unsynced'"),
        ("device", "config_synced_at", "DATETIME"),
        ("device", "last_soc_pct", "FLOAT"),
        ("device", "last_p_ac_kw", "FLOAT"),
        ("device", "last_telemetry_at", "DATETIME"),
        ("device", "opt_out_until", "DATETIME"),
        ("site", "contract_floor_soc_pct", "FLOAT"),
        ("site", "export_limit_kw", "FLOAT"),
        ("site", "import_limit_kw", "FLOAT"),
        ("site", "site_headroom_source", "VARCHAR NOT NULL DEFAULT 'assumed_default'"),
        ("threshold_rule", "instruction_type", "VARCHAR NOT NULL DEFAULT 'fixed'"),
        ("threshold_rule", "target_kw", "FLOAT"),
        ("threshold_rule", "duration_min", "INTEGER"),
        ("channel_message", "allocation_id", "VARCHAR"),
    )
    with engine.connect() as conn:
        for table, column, ddl in alters:
            info = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            if not info:
                continue
            names = {row[1] for row in info}
            if column not in names:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        device_cols = {
            row[1] for row in conn.exec_driver_sql("PRAGMA table_info(device)").fetchall()
        }
        if "reachability_status" in device_cols and "device_status" in device_cols:
            conn.exec_driver_sql(
                """
                UPDATE device SET device_status = CASE reachability_status
                    WHEN 'reachable' THEN 'active'
                    WHEN 'paused' THEN 'paused'
                    WHEN 'unreachable' THEN 'decommissioned'
                    ELSE device_status
                END
                """
            )
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_rule_signal ON dispatch_log (rule_id, signal_id)"
        )
        conn.commit()


def default_db_path() -> Path:
    root = Path(__file__).resolve().parents[2]
    data = root / "data"
    data.mkdir(exist_ok=True)
    return data / "l0.sqlite"


def make_engine(url: str | None = None):
    if url is None:
        url = f"sqlite:///{default_db_path()}"
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args, future=True)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _enable_fk(dbapi_conn, _connection_record):  # noqa: ANN001
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
    return engine


class Store:
    def __init__(self, url: str | None = None) -> None:
        self.engine = make_engine(url)
        Base.metadata.create_all(self.engine)
        _migrate_sqlite(self.engine)
        self.Session = sessionmaker(self.engine, expire_on_commit=False, future=True)

    def session(self) -> Session:
        return self.Session()

    # --- sites ---

    def list_sites(self) -> list[Site]:
        with self.session() as s:
            return [_site(r) for r in s.scalars(select(SiteRow).order_by(SiteRow.site_id))]

    def put_site(self, site: Site) -> Site:
        with self.session() as s:
            row = s.get(SiteRow, site.site_id)
            if row is None:
                row = SiteRow(site_id=site.site_id)
                s.add(row)
            row.customer_id = site.customer_id
            row.utility_territory = site.utility_territory
            row.contract_floor_soc_pct = site.contract_floor_soc_pct
            row.export_limit_kw = site.export_limit_kw
            row.import_limit_kw = site.import_limit_kw
            row.site_headroom_source = site.site_headroom_source
            s.commit()
            return _site(row)

    def delete_site(self, site_id: str) -> None:
        with self.session() as s:
            row = s.get(SiteRow, site_id)
            if row is None:
                raise KeyError(site_id)
            if row.devices:
                raise ValueError("site still hosts devices")
            s.delete(row)
            s.commit()

    # --- channels ---

    def list_channels(self) -> list[Channel]:
        with self.session() as s:
            return [_channel(r) for r in s.scalars(select(ChannelRow).order_by(ChannelRow.channel_id))]

    def get_channel(self, channel_id: str) -> Channel:
        with self.session() as s:
            row = s.get(ChannelRow, channel_id)
            if row is None:
                raise KeyError(channel_id)
            return _channel(row)

    def put_channel(self, channel: Channel) -> Channel:
        with self.session() as s:
            row = s.get(ChannelRow, channel.channel_id)
            if row is None:
                row = ChannelRow(channel_id=channel.channel_id)
                s.add(row)
            row.channel_type = channel.channel_type
            row.endpoint = channel.endpoint
            s.commit()
            return _channel(row)

    def delete_channel(self, channel_id: str) -> None:
        with self.session() as s:
            row = s.get(ChannelRow, channel_id)
            if row is None:
                raise KeyError(channel_id)
            if row.devices:
                raise ValueError("channel still reaches devices")
            s.delete(row)
            s.commit()

    # --- devices ---

    def list_devices(self) -> list[Device]:
        with self.session() as s:
            return [_device(r) for r in s.scalars(select(DeviceRow).order_by(DeviceRow.device_id))]

    def get_device(self, device_id: str) -> Device:
        with self.session() as s:
            row = s.get(DeviceRow, device_id)
            if row is None:
                raise KeyError(device_id)
            return _device(row)

    def put_device(self, device: Device) -> Device:
        with self.session() as s:
            if s.get(SiteRow, device.site_id) is None:
                raise ValueError(f"unknown site_id {device.site_id}")
            if s.get(ChannelRow, device.channel_id) is None:
                raise ValueError(f"unknown channel_id {device.channel_id}")
            row = s.get(DeviceRow, device.device_id)
            creating = row is None
            prev_reserve = None if creating else row.reserve_bound_pct
            prev_config = None if creating else row.config_status
            if row is None:
                row = DeviceRow(device_id=device.device_id)
                s.add(row)
            row.site_id = device.site_id
            row.channel_id = device.channel_id
            row.device_class = device.device_class
            row.rated_capacity_kw = device.rated_capacity_kw
            row.reserve_bound_pct = device.reserve_bound_pct
            row.device_status = device.device_status
            row.current_dispatch_state = device.current_dispatch_state
            if (
                not creating
                and prev_reserve != device.reserve_bound_pct
                and prev_config in ("synced", "pending")
            ):
                row.config_status = "stale"
            else:
                row.config_status = device.config_status
            row.config_synced_at = device.config_synced_at
            row.last_soc_pct = device.last_soc_pct
            row.last_p_ac_kw = device.last_p_ac_kw
            row.last_telemetry_at = device.last_telemetry_at
            row.opt_out_until = device.opt_out_until
            s.commit()
            return _device(row)

    def delete_device(self, device_id: str) -> None:
        with self.session() as s:
            row = s.get(DeviceRow, device_id)
            if row is None:
                raise KeyError(device_id)
            s.execute(delete(ChannelMessageRow).where(ChannelMessageRow.device_id == device_id))
            s.execute(delete(ListMembershipRow).where(ListMembershipRow.device_id == device_id))
            s.delete(row)
            s.commit()

    # --- lists ---

    def list_broadcast_lists(self) -> list[BroadcastList]:
        with self.session() as s:
            return [
                _list(r)
                for r in s.scalars(select(BroadcastListRow).order_by(BroadcastListRow.list_id))
            ]

    def put_list(self, broadcast_list: BroadcastList) -> BroadcastList:
        with self.session() as s:
            row = s.get(BroadcastListRow, broadcast_list.list_id)
            if row is None:
                row = BroadcastListRow(list_id=broadcast_list.list_id)
                s.add(row)
            row.name = broadcast_list.name
            s.commit()
            return _list(row)

    def delete_list(self, list_id: str) -> None:
        with self.session() as s:
            row = s.get(BroadcastListRow, list_id)
            if row is None:
                raise KeyError(list_id)
            if row.rules:
                raise ValueError("list is still targeted by threshold rules")
            s.execute(delete(ListMembershipRow).where(ListMembershipRow.list_id == list_id))
            s.delete(row)
            s.commit()

    def memberships(self, list_id: str | None = None) -> list[ListMembership]:
        with self.session() as s:
            stmt = select(ListMembershipRow)
            if list_id is not None:
                stmt = stmt.where(ListMembershipRow.list_id == list_id)
            return [_member(r) for r in s.scalars(stmt.order_by(ListMembershipRow.list_id, ListMembershipRow.device_id))]

    def add_member(self, list_id: str, device_id: str) -> ListMembership:
        with self.session() as s:
            if s.get(BroadcastListRow, list_id) is None:
                raise ValueError(f"unknown list_id {list_id}")
            if s.get(DeviceRow, device_id) is None:
                raise ValueError(f"unknown device_id {device_id}")
            existing = s.get(ListMembershipRow, (device_id, list_id))
            if existing is None:
                existing = ListMembershipRow(device_id=device_id, list_id=list_id)
                s.add(existing)
                s.commit()
            return _member(existing)

    def remove_member(self, list_id: str, device_id: str) -> None:
        with self.session() as s:
            row = s.get(ListMembershipRow, (device_id, list_id))
            if row is None:
                raise KeyError((device_id, list_id))
            s.delete(row)
            s.commit()

    def devices_on_list(self, list_id: str) -> list[Device]:
        with self.session() as s:
            stmt = (
                select(DeviceRow)
                .join(ListMembershipRow, ListMembershipRow.device_id == DeviceRow.device_id)
                .where(ListMembershipRow.list_id == list_id)
                .order_by(DeviceRow.device_id)
            )
            return [_device(r) for r in s.scalars(stmt)]

    # --- rules ---

    def list_rules(self) -> list[ThresholdRule]:
        with self.session() as s:
            return [
                _rule(r)
                for r in s.scalars(
                    select(ThresholdRuleRow).order_by(ThresholdRuleRow.priority, ThresholdRuleRow.rule_id)
                )
            ]

    def threshold_rules_where(self, signal_source: str) -> list[ThresholdRule]:
        with self.session() as s:
            stmt = (
                select(ThresholdRuleRow)
                .where(ThresholdRuleRow.signal_source == signal_source)
                .where(ThresholdRuleRow.is_active.is_(True))
                .order_by(ThresholdRuleRow.priority, ThresholdRuleRow.rule_id)
            )
            return [_rule(r) for r in s.scalars(stmt)]

    def put_rule(self, rule: ThresholdRule) -> ThresholdRule:
        with self.session() as s:
            if s.get(BroadcastListRow, rule.list_id) is None:
                raise ValueError(f"unknown list_id {rule.list_id}")
            row = s.get(ThresholdRuleRow, rule.rule_id)
            if row is None:
                row = ThresholdRuleRow(rule_id=rule.rule_id)
                s.add(row)
            row.signal_source = rule.signal_source
            row.comparator = rule.comparator
            row.threshold_value = rule.threshold_value
            row.list_id = rule.list_id
            row.fixed_instruction = rule.fixed_instruction
            row.priority = rule.priority
            row.is_active = rule.is_active
            row.instruction_type = rule.instruction_type
            row.target_kw = rule.target_kw
            row.duration_min = rule.duration_min
            s.commit()
            return _rule(row)

    def delete_rule(self, rule_id: str) -> None:
        with self.session() as s:
            row = s.get(ThresholdRuleRow, rule_id)
            if row is None:
                raise KeyError(rule_id)
            if row.events:
                raise ValueError("rule still has dispatch log rows")
            s.delete(row)
            s.commit()

    # --- dispatch log ---

    def list_dispatch_log(self) -> list[DispatchLog]:
        with self.session() as s:
            stmt = select(DispatchLogRow).order_by(DispatchLogRow.triggered_at.desc(), DispatchLogRow.event_id)
            return [_event(r) for r in s.scalars(stmt)]

    def dispatch_exists(self, rule_id: str, signal_id: str) -> bool:
        if not signal_id:
            return False
        with self.session() as s:
            row = s.scalars(
                select(DispatchLogRow)
                .where(DispatchLogRow.rule_id == rule_id)
                .where(DispatchLogRow.signal_id == signal_id)
                .limit(1)
            ).first()
            return row is not None

    def create_dispatch_log(
        self,
        *,
        rule_id: str,
        triggered_at: datetime,
        instruction_text: str,
        signal_id: str = "",
        event_id: str | None = None,
    ) -> DispatchLog:
        with self.session() as s:
            row = DispatchLogRow(
                event_id=event_id or new_id("event"),
                rule_id=rule_id,
                triggered_at=triggered_at,
                instruction_text=instruction_text,
                signal_id=signal_id,
            )
            s.add(row)
            s.commit()
            return _event(row)

    def list_messages(self) -> list[ChannelMessage]:
        with self.session() as s:
            stmt = select(ChannelMessageRow).order_by(ChannelMessageRow.sent_at.desc(), ChannelMessageRow.message_id)
            return [_message(r) for r in s.scalars(stmt)]

    def get_message(self, message_id: str) -> ChannelMessage:
        with self.session() as s:
            row = s.get(ChannelMessageRow, message_id)
            if row is None:
                raise KeyError(message_id)
            return _message(row)

    def create_message(self, msg: ChannelMessage) -> ChannelMessage:
        with self.session() as s:
            row = ChannelMessageRow(
                message_id=msg.message_id,
                device_id=msg.device_id,
                event_id=msg.event_id,
                message_type=msg.message_type,
                payload=msg.payload,
                status=msg.status,
                sent_at=msg.sent_at,
                ack_at=msg.ack_at,
                timeout_seconds=msg.timeout_seconds,
                attempt_number=msg.attempt_number,
                retry_of_message_id=msg.retry_of_message_id,
                allocation_id=msg.allocation_id,
            )
            s.add(row)
            s.commit()
            return _message(row)

    def update_message_if_status(self, message_id: str, expected: str, **fields) -> ChannelMessage | None:
        with self.session() as s:
            row = s.get(ChannelMessageRow, message_id)
            if row is None or row.status != expected:
                return None
            for key, value in fields.items():
                setattr(row, key, value)
            s.commit()
            return _message(row)

    def pending_messages(self) -> list[ChannelMessage]:
        with self.session() as s:
            stmt = select(ChannelMessageRow).where(ChannelMessageRow.status == "pending")
            return [_message(r) for r in s.scalars(stmt)]

    def set_dispatch_state(self, device_id: str, state: str) -> Device:
        with self.session() as s:
            row = s.get(DeviceRow, device_id)
            if row is None:
                raise KeyError(device_id)
            row.current_dispatch_state = state
            s.commit()
            return _device(row)

    def set_config(self, device_id: str, status: str, synced_at: datetime | None = None) -> Device:
        with self.session() as s:
            row = s.get(DeviceRow, device_id)
            if row is None:
                raise KeyError(device_id)
            row.config_status = status
            if synced_at is not None:
                row.config_synced_at = synced_at
            s.commit()
            return _device(row)

    def has_in_flight(self, device_id: str) -> bool:
        with self.session() as s:
            row = s.scalars(
                select(ChannelMessageRow)
                .where(ChannelMessageRow.device_id == device_id)
                .where(ChannelMessageRow.status == "pending")
                .limit(1)
            ).first()
            return row is not None

    def put_capability(self, cap: DeviceCapability) -> DeviceCapability:
        with self.session() as s:
            if s.get(DeviceRow, cap.device_id) is None:
                raise ValueError(f"unknown device_id {cap.device_id}")
            row = s.get(DeviceCapabilityRow, cap.device_id)
            if row is None:
                row = DeviceCapabilityRow(device_id=cap.device_id, capability_version=cap.capability_version)
                s.add(row)
            else:
                row.capability_version = cap.capability_version
            row.energy_capacity_kwh = cap.energy_capacity_kwh
            row.p_discharge_max_kw = cap.p_discharge_max_kw
            row.p_charge_max_kw = cap.p_charge_max_kw
            row.eta_discharge = cap.eta_discharge
            row.eta_charge = cap.eta_charge
            row.soc_min_pct = cap.soc_min_pct
            row.soc_max_pct = cap.soc_max_pct
            row.control_mode = cap.control_mode
            row.setpoint_step_kw = cap.setpoint_step_kw
            if row.capability_version is None:
                row.capability_version = 1
            s.commit()
            return _cap(row)

    def get_capability(self, device_id: str) -> DeviceCapability | None:
        with self.session() as s:
            row = s.get(DeviceCapabilityRow, device_id)
            return _cap(row) if row else None

    def list_capabilities(self) -> list[DeviceCapability]:
        with self.session() as s:
            return [_cap(r) for r in s.scalars(select(DeviceCapabilityRow).order_by(DeviceCapabilityRow.device_id))]

    def ingest_telemetry(self, sample: TelemetrySample) -> TelemetrySample:
        with self.session() as s:
            if s.get(DeviceRow, sample.device_id) is None:
                raise ValueError(f"unknown device_id {sample.device_id}")
            row = TelemetrySampleRow(
                sample_id=sample.sample_id,
                device_id=sample.device_id,
                observed_at=sample.observed_at,
                ingested_at=sample.ingested_at,
                soc_pct=sample.soc_pct,
                p_ac_kw=sample.p_ac_kw,
                source=sample.source,
            )
            s.add(row)
            device = s.get(DeviceRow, sample.device_id)
            device.last_soc_pct = sample.soc_pct
            device.last_p_ac_kw = sample.p_ac_kw
            device.last_telemetry_at = sample.observed_at
            s.commit()
            return _telemetry(row)

    def list_telemetry(self, device_id: str | None = None) -> list[TelemetrySample]:
        with self.session() as s:
            stmt = select(TelemetrySampleRow).order_by(TelemetrySampleRow.observed_at.desc())
            if device_id:
                stmt = stmt.where(TelemetrySampleRow.device_id == device_id)
            return [_telemetry(r) for r in s.scalars(stmt)]

    def create_solver_run(self, run: SolverRun) -> SolverRun:
        with self.session() as s:
            row = SolverRunRow(
                run_id=run.run_id,
                event_id=run.event_id,
                run_number=run.run_number,
                solved_at=run.solved_at,
                telemetry_cutoff_at=run.telemetry_cutoff_at,
                target_kw=run.target_kw,
                eligible_count=run.eligible_count,
                total_headroom_kw=run.total_headroom_kw,
                allocated_kw=run.allocated_kw,
                shortfall_kw=run.shortfall_kw,
                lam=run.lam,
                sites_binding_count=run.sites_binding_count,
                quantization_loss_kw=run.quantization_loss_kw,
                status=run.status,
            )
            s.add(row)
            s.commit()
            return _run(row)

    def list_solver_runs(self, event_id: str | None = None) -> list[SolverRun]:
        with self.session() as s:
            stmt = select(SolverRunRow).order_by(SolverRunRow.solved_at.desc())
            if event_id:
                stmt = stmt.where(SolverRunRow.event_id == event_id)
            return [_run(r) for r in s.scalars(stmt)]

    def get_solver_run(self, run_id: str) -> SolverRun:
        with self.session() as s:
            row = s.get(SolverRunRow, run_id)
            if row is None:
                raise KeyError(run_id)
            return _run(row)

    def create_allocation(self, alloc: DeviceAllocation) -> DeviceAllocation:
        with self.session() as s:
            row = DeviceAllocationRow(
                allocation_id=alloc.allocation_id,
                run_id=alloc.run_id,
                device_id=alloc.device_id,
                capability_version=alloc.capability_version,
                soc_at_solve_pct=alloc.soc_at_solve_pct,
                floor_soc_pct=alloc.floor_soc_pct,
                headroom_kw=alloc.headroom_kw,
                p_setpoint_kw=alloc.p_setpoint_kw,
                p_setpoint_raw_kw=alloc.p_setpoint_raw_kw,
                expected_energy_kwh=alloc.expected_energy_kwh,
                binding_constraint=alloc.binding_constraint,
                delivered_kwh=alloc.delivered_kwh,
                status=alloc.status,
            )
            s.add(row)
            s.commit()
            return _alloc(row)

    def list_allocations(self, event_id: str | None = None) -> list[DeviceAllocation]:
        with self.session() as s:
            stmt = select(DeviceAllocationRow).order_by(DeviceAllocationRow.allocation_id)
            if event_id:
                stmt = (
                    stmt.join(SolverRunRow, SolverRunRow.run_id == DeviceAllocationRow.run_id)
                    .where(SolverRunRow.event_id == event_id)
                )
            return [_alloc(r) for r in s.scalars(stmt)]

    def get_allocation(self, allocation_id: str) -> DeviceAllocation:
        with self.session() as s:
            row = s.get(DeviceAllocationRow, allocation_id)
            if row is None:
                raise KeyError(allocation_id)
            return _alloc(row)

    def set_allocation_delivered(self, allocation_id: str, delivered_kwh: float) -> DeviceAllocation:
        with self.session() as s:
            row = s.get(DeviceAllocationRow, allocation_id)
            if row is None:
                raise KeyError(allocation_id)
            row.delivered_kwh = delivered_kwh
            s.commit()
            return _alloc(row)

    def set_allocation_status(self, allocation_id: str, status: str) -> DeviceAllocation:
        with self.session() as s:
            row = s.get(DeviceAllocationRow, allocation_id)
            if row is None:
                raise KeyError(allocation_id)
            row.status = status
            s.commit()
            return _alloc(row)

    def create_reservation(self, res: HeadroomReservation) -> HeadroomReservation:
        with self.session() as s:
            row = HeadroomReservationRow(
                reservation_id=res.reservation_id,
                device_id=res.device_id,
                site_id=res.site_id,
                run_id=res.run_id,
                allocation_id=res.allocation_id,
                reserved_kw=res.reserved_kw,
                reserved_energy_kwh=res.reserved_energy_kwh,
                held_from=res.held_from,
                held_until=res.held_until,
                status=res.status,
            )
            s.add(row)
            s.commit()
            return _res(row)

    def list_reservations(self) -> list[HeadroomReservation]:
        with self.session() as s:
            return [
                _res(r)
                for r in s.scalars(select(HeadroomReservationRow).order_by(HeadroomReservationRow.held_from.desc()))
            ]

    def live_reservations(self, now: datetime) -> list[HeadroomReservation]:
        with self.session() as s:
            stmt = select(HeadroomReservationRow).where(
                HeadroomReservationRow.status.in_(("held", "committed"))
            )
            rows = []
            for r in s.scalars(stmt):
                until = r.held_until
                if getattr(until, "tzinfo", None) is None and getattr(now, "tzinfo", None) is not None:
                    until = until.replace(tzinfo=now.tzinfo)
                if until >= now:
                    rows.append(_res(r))
            return rows

    def set_reservation_status(self, reservation_id: str, status: str) -> None:
        with self.session() as s:
            row = s.get(HeadroomReservationRow, reservation_id)
            if row is None:
                raise KeyError(reservation_id)
            row.status = status
            s.commit()

    def release_reservation_for_allocation(self, allocation_id: str) -> None:
        with self.session() as s:
            stmt = select(HeadroomReservationRow).where(
                HeadroomReservationRow.allocation_id == allocation_id
            )
            for row in s.scalars(stmt):
                row.status = "released"
            s.commit()

    def commit_reservation_for_allocation(self, allocation_id: str) -> None:
        with self.session() as s:
            stmt = select(HeadroomReservationRow).where(
                HeadroomReservationRow.allocation_id == allocation_id
            )
            for row in s.scalars(stmt):
                if row.status == "held":
                    row.status = "committed"
            s.commit()

    def release_reservations_for_event(self, event_id: str) -> None:
        with self.session() as s:
            stmt = (
                select(HeadroomReservationRow)
                .join(SolverRunRow, SolverRunRow.run_id == HeadroomReservationRow.run_id)
                .where(SolverRunRow.event_id == event_id)
            )
            for row in s.scalars(stmt):
                row.status = "released"
            s.commit()

    def expire_reservations(self, now: datetime) -> int:
        n = 0
        with self.session() as s:
            stmt = select(HeadroomReservationRow).where(
                HeadroomReservationRow.status.in_(("held", "committed"))
            )
            for row in s.scalars(stmt):
                until = row.held_until
                if getattr(until, "tzinfo", None) is None and getattr(now, "tzinfo", None) is not None:
                    until = until.replace(tzinfo=now.tzinfo)
                if until < now:
                    row.status = "released"
                    n += 1
            s.commit()
        return n

    def get_rule(self, rule_id: str) -> ThresholdRule:
        with self.session() as s:
            row = s.get(ThresholdRuleRow, rule_id)
            if row is None:
                raise KeyError(rule_id)
            return _rule(row)

    def get_event(self, event_id: str) -> DispatchLog:
        with self.session() as s:
            row = s.get(DispatchLogRow, event_id)
            if row is None:
                raise KeyError(event_id)
            return _event(row)


def _site(r: SiteRow) -> Site:
    return Site(
        site_id=r.site_id,
        customer_id=r.customer_id,
        utility_territory=r.utility_territory,
        contract_floor_soc_pct=getattr(r, "contract_floor_soc_pct", None),
        export_limit_kw=getattr(r, "export_limit_kw", None),
        import_limit_kw=getattr(r, "import_limit_kw", None),
        site_headroom_source=getattr(r, "site_headroom_source", None) or "assumed_default",
    )


def _channel(r: ChannelRow) -> Channel:
    return Channel(channel_id=r.channel_id, channel_type=r.channel_type, endpoint=r.endpoint)


def _device(r: DeviceRow) -> Device:
    return Device(
        device_id=r.device_id,
        site_id=r.site_id,
        channel_id=r.channel_id,
        device_class=r.device_class,
        rated_capacity_kw=r.rated_capacity_kw,
        reserve_bound_pct=r.reserve_bound_pct,
        device_status=r.device_status,
        current_dispatch_state=getattr(r, "current_dispatch_state", "idle") or "idle",
        config_status=getattr(r, "config_status", "unsynced") or "unsynced",
        config_synced_at=getattr(r, "config_synced_at", None),
        last_soc_pct=getattr(r, "last_soc_pct", None),
        last_p_ac_kw=getattr(r, "last_p_ac_kw", None),
        last_telemetry_at=getattr(r, "last_telemetry_at", None),
        opt_out_until=getattr(r, "opt_out_until", None),
    )


def _message(r: ChannelMessageRow) -> ChannelMessage:
    return ChannelMessage(
        message_id=r.message_id,
        device_id=r.device_id,
        event_id=r.event_id,
        message_type=r.message_type,
        payload=r.payload,
        status=r.status,
        sent_at=r.sent_at,
        ack_at=r.ack_at,
        timeout_seconds=r.timeout_seconds,
        attempt_number=r.attempt_number,
        retry_of_message_id=r.retry_of_message_id,
        allocation_id=getattr(r, "allocation_id", None),
    )


def _list(r: BroadcastListRow) -> BroadcastList:
    return BroadcastList(list_id=r.list_id, name=r.name)


def _member(r: ListMembershipRow) -> ListMembership:
    return ListMembership(device_id=r.device_id, list_id=r.list_id)


def _rule(r: ThresholdRuleRow) -> ThresholdRule:
    return ThresholdRule(
        rule_id=r.rule_id,
        signal_source=r.signal_source,
        comparator=r.comparator,
        threshold_value=r.threshold_value,
        list_id=r.list_id,
        fixed_instruction=r.fixed_instruction,
        priority=r.priority,
        is_active=r.is_active,
        instruction_type=getattr(r, "instruction_type", None) or "fixed",
        target_kw=getattr(r, "target_kw", None),
        duration_min=getattr(r, "duration_min", None),
    )


def _event(r: DispatchLogRow) -> DispatchLog:
    return DispatchLog(
        event_id=r.event_id,
        rule_id=r.rule_id,
        triggered_at=r.triggered_at,
        instruction_text=r.instruction_text,
        signal_id=r.signal_id,
    )


def _cap(r: DeviceCapabilityRow) -> DeviceCapability:
    return DeviceCapability(
        device_id=r.device_id,
        energy_capacity_kwh=r.energy_capacity_kwh,
        p_discharge_max_kw=r.p_discharge_max_kw,
        p_charge_max_kw=r.p_charge_max_kw,
        eta_discharge=r.eta_discharge,
        eta_charge=r.eta_charge,
        soc_min_pct=r.soc_min_pct,
        soc_max_pct=r.soc_max_pct,
        control_mode=r.control_mode,
        setpoint_step_kw=r.setpoint_step_kw,
        capability_version=r.capability_version,
    )


def _telemetry(r: TelemetrySampleRow) -> TelemetrySample:
    return TelemetrySample(
        sample_id=r.sample_id,
        device_id=r.device_id,
        observed_at=r.observed_at,
        ingested_at=r.ingested_at,
        soc_pct=r.soc_pct,
        p_ac_kw=r.p_ac_kw,
        source=r.source,
    )


def _run(r: SolverRunRow) -> SolverRun:
    return SolverRun(
        run_id=r.run_id,
        event_id=r.event_id,
        run_number=r.run_number,
        solved_at=r.solved_at,
        telemetry_cutoff_at=r.telemetry_cutoff_at,
        target_kw=r.target_kw,
        eligible_count=r.eligible_count,
        total_headroom_kw=r.total_headroom_kw,
        allocated_kw=r.allocated_kw,
        shortfall_kw=r.shortfall_kw,
        lam=r.lam,
        sites_binding_count=r.sites_binding_count,
        quantization_loss_kw=r.quantization_loss_kw,
        status=r.status,
    )


def _alloc(r: DeviceAllocationRow) -> DeviceAllocation:
    return DeviceAllocation(
        allocation_id=r.allocation_id,
        run_id=r.run_id,
        device_id=r.device_id,
        capability_version=r.capability_version,
        soc_at_solve_pct=r.soc_at_solve_pct,
        floor_soc_pct=r.floor_soc_pct,
        headroom_kw=r.headroom_kw,
        p_setpoint_kw=r.p_setpoint_kw,
        p_setpoint_raw_kw=r.p_setpoint_raw_kw,
        expected_energy_kwh=r.expected_energy_kwh,
        binding_constraint=r.binding_constraint,
        status=r.status,
        delivered_kwh=r.delivered_kwh,
    )


def _res(r: HeadroomReservationRow) -> HeadroomReservation:
    return HeadroomReservation(
        reservation_id=r.reservation_id,
        device_id=r.device_id,
        site_id=r.site_id,
        run_id=r.run_id,
        reserved_kw=r.reserved_kw,
        reserved_energy_kwh=r.reserved_energy_kwh,
        held_from=r.held_from,
        held_until=r.held_until,
        status=r.status,
        allocation_id=r.allocation_id,
    )
