export type Tab =
  | "dash"
  | "demo"
  | "flow"
  | "orch"
  | "reach"
  | "inventory"
  | "lists"
  | "rules"
  | "signals"
  | "messages"
  | "alloc"
  | "log";

export type Site = {
  site_id: string;
  customer_id: string;
  utility_territory: string;
  contract_floor_soc_pct: number | null;
  export_limit_kw: number | null;
  import_limit_kw: number | null;
  site_headroom_source: string;
};

export type Channel = {
  channel_id: string;
  channel_type: string;
  endpoint: string;
};

export type Device = {
  device_id: string;
  site_id: string;
  channel_id: string;
  device_class: string;
  rated_capacity_kw: number;
  reserve_bound_pct: number;
  device_status: "active" | "paused" | "decommissioned";
  current_dispatch_state: "idle" | "dispatched" | "completed" | "failed";
  config_status: "unsynced" | "pending" | "synced" | "stale" | "failed";
  config_synced_at: string | null;
  last_soc_pct: number | null;
  last_p_ac_kw: number | null;
  last_telemetry_at: string | null;
  opt_out_until: string | null;
  sim?: "ack" | "nack" | "timeout" | "nack_then_ack";
};

export type DeviceCapability = {
  device_id: string;
  energy_capacity_kwh: number;
  p_discharge_max_kw: number;
  p_charge_max_kw: number;
  eta_discharge: number;
  eta_charge: number;
  soc_min_pct: number;
  soc_max_pct: number;
  control_mode: "continuous" | "binary";
  setpoint_step_kw: number;
  capability_version: number;
};

export type TelemetrySample = {
  sample_id: string;
  device_id: string;
  observed_at: string;
  ingested_at: string;
  soc_pct: number;
  p_ac_kw: number;
  source: string;
};

export type SolverRun = {
  run_id: string;
  event_id: string;
  run_number: number;
  solved_at: string;
  target_kw: number;
  eligible_count: number;
  total_headroom_kw: number;
  allocated_kw: number;
  shortfall_kw: number;
  lambda: number;
  sites_binding_count: number;
  quantization_loss_kw: number;
  status: string;
};

export type DeviceAllocation = {
  allocation_id: string;
  run_id: string;
  device_id: string;
  capability_version: number;
  soc_at_solve_pct: number;
  floor_soc_pct: number;
  headroom_kw: number;
  p_setpoint_kw: number;
  p_setpoint_raw_kw: number;
  expected_energy_kwh: number;
  binding_constraint: string;
  status: string;
  delivered_kwh: number | null;
};

export type HeadroomReservation = {
  reservation_id: string;
  device_id: string;
  site_id: string;
  run_id: string;
  allocation_id: string | null;
  reserved_kw: number;
  reserved_energy_kwh: number;
  held_from: string;
  held_until: string;
  status: "held" | "committed" | "released";
};

export type BroadcastList = {
  list_id: string;
  name: string;
  device_ids: string[];
};

export type ThresholdRule = {
  rule_id: string;
  signal_source: string;
  comparator: string;
  threshold_value: number;
  list_id: string;
  fixed_instruction: string;
  priority: number;
  is_active: boolean;
  instruction_type: "fixed" | "fleet_target";
  target_kw: number | null;
  duration_min: number | null;
};

export type DispatchEvent = {
  event_id: string;
  rule_id: string;
  triggered_at: string;
  instruction_text: string;
  signal_id: string;
};

export type ChannelMessage = {
  message_id: string;
  device_id: string;
  event_id: string | null;
  message_type: "dispatch_instruction" | "config_sync" | "setpoint_revision" | "release";
  payload: string;
  status: "pending" | "acked" | "nacked" | "timed_out";
  sent_at: string;
  ack_at: string | null;
  timeout_seconds: number;
  attempt_number: number;
  retry_of_message_id: string | null;
  allocation_id: string | null;
};

export type SendAttempt = {
  send_id: string;
  channel_id: string;
  channel_type: string;
  endpoint: string;
  instruction_text: string;
  attempted_at: string;
};

export type Snapshot = {
  sites: Site[];
  channels: Channel[];
  devices: Device[];
  lists: BroadcastList[];
  rules: ThresholdRule[];
  dispatch_log: DispatchEvent[];
  sends: SendAttempt[];
  messages: ChannelMessage[];
  capabilities: DeviceCapability[];
  telemetry: TelemetrySample[];
  solver_runs: SolverRun[];
  allocations: DeviceAllocation[];
  reservations: HeadroomReservation[];
};

export type SignalTrace = {
  rule_id: string;
  comparator: string;
  threshold_value: number;
  list_id: string;
  fixed_instruction: string;
  priority: number;
  crossed: boolean;
  skipped_duplicate: boolean;
  device_ids: string[];
};

export type SignalResult = {
  signal: { source: string; value: number; signal_id: string };
  skipped_duplicate: boolean;
  matching_rule_ids: string[];
  fired_event_ids: string[];
  trace: SignalTrace[];
  dispatch_log: DispatchEvent[];
  sends: SendAttempt[];
  messages: ChannelMessage[];
  allocations: DeviceAllocation[];
  solver_runs: SolverRun[];
};
