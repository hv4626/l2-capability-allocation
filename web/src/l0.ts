import type {
  BroadcastList,
  Channel,
  ChannelMessage,
  Device,
  DeviceAllocation,
  DeviceCapability,
  DispatchEvent,
  HeadroomReservation,
  SignalResult,
  Site,
  Snapshot,
  SolverRun,
  ThresholdRule,
} from "./types";

const KEY = "l2-capability-allocation-state";
const MAX_DISPATCH_RETRIES = 2;
const MAX_CONFIG_RETRIES = 3;
const ACK_TIMEOUT = 2;
const CONFIG_TIMEOUT = 3;
const MAX_REALLOCATIONS = 3;
const TELEMETRY_STALE_MS = 15 * 60_000;
const COMPARATORS = [">", ">=", "<", "<=", "==", "!="] as const;

type State = Snapshot;

function empty(): State {
  return {
    sites: [],
    channels: [],
    devices: [],
    lists: [],
    rules: [],
    dispatch_log: [],
    sends: [],
    messages: [],
    capabilities: [],
    telemetry: [],
    solver_runs: [],
    allocations: [],
    reservations: [],
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as State;
    return {
      ...empty(),
      ...parsed,
      devices: (parsed.devices ?? []).map((d) => {
        const legacy = (d as Device & { reachability_status?: string }).reachability_status;
        const mapped =
          d.device_status ??
          (legacy === "reachable"
            ? "active"
            : legacy === "unreachable"
              ? "decommissioned"
              : legacy === "paused"
                ? "paused"
                : "active");
        return {
          ...d,
          device_status: mapped,
          current_dispatch_state: d.current_dispatch_state ?? "idle",
          config_status: d.config_status ?? "unsynced",
          config_synced_at: d.config_synced_at ?? null,
          last_soc_pct: d.last_soc_pct ?? null,
          last_p_ac_kw: d.last_p_ac_kw ?? null,
          last_telemetry_at: d.last_telemetry_at ?? null,
          opt_out_until: d.opt_out_until ?? null,
        };
      }),
      messages: parsed.messages ?? [],
      capabilities: parsed.capabilities ?? [],
      telemetry: parsed.telemetry ?? [],
      solver_runs: parsed.solver_runs ?? [],
      allocations: parsed.allocations ?? [],
      reservations: parsed.reservations ?? [],
      rules: (parsed.rules ?? []).map((r) => ({
        ...r,
        priority: r.priority ?? 100,
        is_active: r.is_active ?? true,
        instruction_type: r.instruction_type ?? "fixed",
        target_kw: r.target_kw ?? null,
        duration_min: r.duration_min ?? null,
      })),
      dispatch_log: (parsed.dispatch_log ?? []).map((e) => ({
        ...e,
        signal_id: e.signal_id ?? "",
      })),
    };
  } catch {
    return empty();
  }
}

function save(state: State): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

let state: State = load();

function nid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function snap(): Snapshot {
  return structuredClone(state);
}

export function compare(value: number, comparator: string, threshold: number): boolean {
  switch (comparator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
    default:
      throw new Error(`unsupported comparator: ${comparator}`);
  }
}

export function seedFleet(): Snapshot {
  state = empty();
  for (const k of Object.keys(attemptCount)) delete attemptCount[k];
  for (const s of [
    site("sit_jayanagar", "cust_ramesh", "BESCOM", 10, 4, 5, "measured"),
    site("sit_koramangala", "cust_nair", "BESCOM", 10, 20, 20, "nameplate"),
    site("sit_andheri", "cust_mehta", "MSEDCL", 12, 15, 15, "measured"),
    site("sit_pune", "cust_deshmukh", "MSEDCL", 15, 8, 8, "assumed_default"),
    site("sit_adyar", "cust_iyer", "TANGEDCO", 10, null, null, "assumed_default"),
  ])
    state.sites.push(s);
  for (const c of [
    ch("ch_relay_jayanagar", "relay", "gw://jayanagar-ven"),
    ch("ch_sms_nair", "sms", "+919876543210"),
    ch("ch_api_andheri", "api", "https://ven.example/andheri"),
    ch("ch_phone_pune", "phone", "+912022334455"),
    ch("ch_relay_adyar", "relay", "gw://adyar-ven"),
    ch("ch_sms_jayanagar", "sms", "+919811122233"),
  ])
    state.channels.push(c);
  for (const d of [
    dev("dev_jay_batt", "sit_jayanagar", "ch_relay_jayanagar", "battery", 5, 20, "active"),
    dev("dev_jay_tstat", "sit_jayanagar", "ch_sms_jayanagar", "thermostat", 1.5, 0, "active"),
    dev("dev_kora_batt", "sit_koramangala", "ch_sms_nair", "battery", 10, 15, "active"),
    dev("dev_and_batt", "sit_andheri", "ch_api_andheri", "battery", 7.5, 20, "active"),
    dev("dev_and_tstat", "sit_andheri", "ch_api_andheri", "thermostat", 2, 0, "active"),
    dev("dev_pune_batt", "sit_pune", "ch_phone_pune", "battery", 5, 25, "active"),
    dev("dev_ady_batt", "sit_adyar", "ch_relay_adyar", "battery", 12, 20, "active"),
    dev("dev_ady_tstat", "sit_adyar", "ch_relay_adyar", "thermostat", 1.8, 0, "active"),
  ])
    state.devices.push(d);
  state.lists = [
    { list_id: "lst_peak_batteries", name: "Peak-shave batteries", device_ids: [] },
    { list_id: "lst_hvac", name: "HVAC curtailment", device_ids: [] },
  ];
  for (const id of ["dev_jay_batt", "dev_kora_batt", "dev_and_batt", "dev_pune_batt", "dev_ady_batt"]) {
    addMember("lst_peak_batteries", id);
  }
  for (const id of ["dev_jay_tstat", "dev_and_tstat", "dev_ady_tstat"]) addMember("lst_hvac", id);
  state.capabilities = [
    cap("dev_jay_batt", 10, 5, 5),
    cap("dev_kora_batt", 20, 10, 10),
    cap("dev_and_batt", 15, 7.5, 7.5),
    cap("dev_pune_batt", 10, 5, 5),
    cap("dev_ady_batt", 24, 12, 12),
  ];
  state.rules = [
    {
      rule_id: "rul_forecast_peak",
      signal_source: "forecast_peak",
      comparator: ">",
      threshold_value: 0.85,
      list_id: "lst_peak_batteries",
      fixed_instruction: "",
      priority: 10,
      is_active: true,
      instruction_type: "fleet_target",
      target_kw: 15,
      duration_min: 30,
    },
    {
      rule_id: "rul_discom_call",
      signal_source: "discom_call",
      comparator: ">=",
      threshold_value: 1,
      list_id: "lst_hvac",
      fixed_instruction: "CURTAIL HVAC",
      priority: 20,
      is_active: true,
      instruction_type: "fixed",
      target_kw: null,
      duration_min: null,
    },
  ];
  save(state);
  return snap();
}

export function snapshot(): Snapshot {
  if (
    state.sites.length === 0 &&
    state.devices.length === 0 &&
    state.channels.length === 0
  ) {
    return seedFleet();
  }
  return snap();
}

export function createSite(body: {
  site_id?: string;
  customer_id: string;
  utility_territory: string;
}): Site {
  const row = site(body.site_id || nid("sit"), body.customer_id, body.utility_territory);
  upsert(state.sites, "site_id", row);
  save(state);
  return row;
}

export function deleteSite(id: string): void {
  if (state.devices.some((d) => d.site_id === id)) throw new Error("site still hosts devices");
  state.sites = state.sites.filter((s) => s.site_id !== id);
  save(state);
}

export function createChannel(body: {
  channel_id?: string;
  channel_type: string;
  endpoint: string;
}): Channel {
  const row = ch(body.channel_id || nid("ch"), body.channel_type, body.endpoint);
  upsert(state.channels, "channel_id", row);
  save(state);
  return row;
}

export function deleteChannel(id: string): void {
  if (state.devices.some((d) => d.channel_id === id)) throw new Error("channel still reaches devices");
  state.channels = state.channels.filter((c) => c.channel_id !== id);
  save(state);
}

export function createDevice(body: {
  device_id?: string;
  site_id: string;
  channel_id: string;
  device_class: string;
  rated_capacity_kw: number;
  reserve_bound_pct: number;
  device_status?: Device["device_status"];
}): Device {
  if (!state.sites.some((s) => s.site_id === body.site_id)) throw new Error(`unknown site_id ${body.site_id}`);
  if (!state.channels.some((c) => c.channel_id === body.channel_id)) {
    throw new Error(`unknown channel_id ${body.channel_id}`);
  }
  const existing = state.devices.find((d) => d.device_id === body.device_id);
  const row = {
    ...dev(
      body.device_id || nid("dev"),
      body.site_id,
      body.channel_id,
      body.device_class,
      body.rated_capacity_kw,
      body.reserve_bound_pct,
      body.device_status ?? "active",
    ),
    current_dispatch_state: existing?.current_dispatch_state ?? "idle",
    config_status:
      existing && existing.reserve_bound_pct !== body.reserve_bound_pct && existing.config_status === "synced"
        ? "stale"
        : (existing?.config_status ?? "unsynced"),
    config_synced_at: existing?.config_synced_at ?? null,
    last_soc_pct: existing?.last_soc_pct ?? null,
    last_p_ac_kw: existing?.last_p_ac_kw ?? null,
    last_telemetry_at: existing?.last_telemetry_at ?? null,
    opt_out_until: existing?.opt_out_until ?? null,
    sim: existing?.sim ?? "ack",
  };
  upsert(state.devices, "device_id", row);
  save(state);
  return row;
}

export function deleteDevice(id: string): void {
  for (const lst of state.lists) lst.device_ids = lst.device_ids.filter((d) => d !== id);
  state.devices = state.devices.filter((d) => d.device_id !== id);
  save(state);
}

export function createList(body: { list_id?: string; name: string }): BroadcastList {
  const existing = state.lists.find((l) => l.list_id === body.list_id);
  const row: BroadcastList = {
    list_id: body.list_id || nid("lst"),
    name: body.name,
    device_ids: existing?.device_ids ?? [],
  };
  upsert(state.lists, "list_id", row);
  save(state);
  return row;
}

export function deleteList(id: string): void {
  if (state.rules.some((r) => r.list_id === id)) {
    throw new Error("list is still targeted by threshold rules");
  }
  state.lists = state.lists.filter((l) => l.list_id !== id);
  save(state);
}

export function addMember(listId: string, deviceId: string): { device_id: string; list_id: string } {
  const lst = state.lists.find((l) => l.list_id === listId);
  if (!lst) throw new Error(`unknown list_id ${listId}`);
  if (!state.devices.some((d) => d.device_id === deviceId)) throw new Error(`unknown device_id ${deviceId}`);
  if (!lst.device_ids.includes(deviceId)) lst.device_ids.push(deviceId);
  save(state);
  return { device_id: deviceId, list_id: listId };
}

export function removeMember(listId: string, deviceId: string): void {
  const lst = state.lists.find((l) => l.list_id === listId);
  if (!lst) throw new Error("membership not found");
  lst.device_ids = lst.device_ids.filter((d) => d !== deviceId);
  save(state);
}

export function createRule(body: {
  rule_id?: string;
  signal_source: string;
  comparator: string;
  threshold_value: number;
  list_id: string;
  fixed_instruction: string;
  priority?: number;
  is_active?: boolean;
}): ThresholdRule {
  if (!COMPARATORS.includes(body.comparator as (typeof COMPARATORS)[number])) {
    throw new Error(`comparator must be one of ${COMPARATORS.join(", ")}`);
  }
  if (!state.lists.some((l) => l.list_id === body.list_id)) throw new Error(`unknown list_id ${body.list_id}`);
  const row: ThresholdRule = {
    rule_id: body.rule_id || nid("rul"),
    signal_source: body.signal_source,
    comparator: body.comparator,
    threshold_value: body.threshold_value,
    list_id: body.list_id,
    fixed_instruction: body.fixed_instruction,
    priority: body.priority ?? 100,
    is_active: body.is_active ?? true,
    instruction_type: (body as ThresholdRule).instruction_type ?? "fixed",
    target_kw: (body as ThresholdRule).target_kw ?? null,
    duration_min: (body as ThresholdRule).duration_min ?? null,
  };
  upsert(state.rules, "rule_id", row);
  save(state);
  return row;
}

export function deleteRule(id: string): void {
  if (state.dispatch_log.some((e) => e.rule_id === id)) {
    throw new Error("rule still has dispatch log rows");
  }
  state.rules = state.rules.filter((r) => r.rule_id !== id);
  save(state);
}

const attemptCount: Record<string, number> = {};
const ackTimers = new Map<string, number>();

export function injectSignal(source: string, value: number, signalId?: string): SignalResult {
  const signal_id = signalId || nid("sig");
  const matching = state.rules
    .filter((r) => r.signal_source === source && r.is_active)
    .slice()
    .sort((a, b) => a.priority - b.priority || a.rule_id.localeCompare(b.rule_id));
  const fired_event_ids: string[] = [];
  let skipped_duplicate = false;
  const trace = matching.map((rule) => {
    const crossed = compare(value, rule.comparator, rule.threshold_value);
    const already = state.dispatch_log.some(
      (e) => e.rule_id === rule.rule_id && e.signal_id === signal_id,
    );
    const list = state.lists.find((l) => l.list_id === rule.list_id);
    const sentIds: string[] = [];
    let dup = false;
    if (crossed && already) {
      dup = true;
      skipped_duplicate = true;
    } else if (crossed) {
      const now = new Date().toISOString();
      const instruction =
        rule.instruction_type === "fleet_target"
          ? `FLEET_TARGET ${rule.target_kw}kW ${rule.duration_min}min`
          : rule.fixed_instruction;
      const event: DispatchEvent = {
        event_id: nid("evt"),
        rule_id: rule.rule_id,
        triggered_at: now,
        instruction_text: instruction,
        signal_id,
      };
      state.dispatch_log.unshift(event);
      fired_event_ids.push(event.event_id);
      if (rule.instruction_type === "fleet_target") {
        sentIds.push(...allocateEvent(event, rule, now));
      } else {
        for (const deviceId of list?.device_ids ?? []) {
          const device = state.devices.find((d) => d.device_id === deviceId);
          if (!device || device.device_status !== "active") continue;
          if (hasInFlight(device.device_id)) continue;
          sentIds.push(deviceId);
          sendDispatch(device, event.event_id, rule.fixed_instruction, 1, null);
        }
      }
    }
    return {
      rule_id: rule.rule_id,
      comparator: rule.comparator,
      threshold_value: rule.threshold_value,
      list_id: rule.list_id,
      fixed_instruction: rule.fixed_instruction,
      priority: rule.priority,
      crossed,
      skipped_duplicate: dup,
      device_ids: sentIds,
    };
  });
  save(state);
  return {
    signal: { source, value, signal_id },
    skipped_duplicate,
    matching_rule_ids: matching.map((r) => r.rule_id),
    fired_event_ids,
    trace,
    dispatch_log: snap().dispatch_log,
    sends: snap().sends,
    messages: snap().messages,
    allocations: snap().allocations,
    solver_runs: snap().solver_runs,
  };
}

function sendDispatch(
  device: Device,
  eventId: string,
  instruction: string,
  attempt: number,
  retryOf: string | null,
): void {
  const now = new Date().toISOString();
  const msg: ChannelMessage = {
    message_id: nid("msg"),
    device_id: device.device_id,
    event_id: eventId,
    message_type: "dispatch_instruction",
    payload: instruction,
    status: "pending",
    sent_at: now,
    ack_at: null,
    timeout_seconds: ACK_TIMEOUT,
    attempt_number: attempt,
    retry_of_message_id: retryOf,
    allocation_id: null,
  };
  state.messages.unshift(msg);
  const d = state.devices.find((x) => x.device_id === device.device_id);
  if (d) d.current_dispatch_state = "dispatched";
  const ch = state.channels.find((c) => c.channel_id === device.channel_id);
  if (ch) {
    state.sends.unshift({
      send_id: nid("snd"),
      channel_id: ch.channel_id,
      channel_type: ch.channel_type,
      endpoint: ch.endpoint,
      instruction_text: instruction,
      attempted_at: now,
    });
  }
  scheduleSim(device, msg);
  save(state);
}

function scheduleSim(device: Device, msg: ChannelMessage): void {
  const mode = device.sim ?? "ack";
  const n = (attemptCount[device.device_id] ?? 0) + 1;
  attemptCount[device.device_id] = n;
  let outcome: boolean | null = true;
  if (mode === "nack") outcome = false;
  if (mode === "timeout") outcome = null;
  if (mode === "nack_then_ack") outcome = n === 1 ? false : true;
  if (outcome === null) return;
  const t = window.setTimeout(() => handleAck(msg.message_id, outcome), 400);
  ackTimers.set(msg.message_id, t);
}

export function handleAck(messageId: string, success: boolean): void {
  const msg = state.messages.find((m) => m.message_id === messageId);
  if (!msg || msg.status !== "pending") return;
  msg.status = success ? "acked" : "nacked";
  msg.ack_at = new Date().toISOString();
  const device = state.devices.find((d) => d.device_id === msg.device_id);
  if (success) {
    if ((msg.message_type === "dispatch_instruction" || msg.message_type === "setpoint_revision") && device) {
      device.current_dispatch_state = "completed";
      if (msg.allocation_id) {
        const a = state.allocations.find((x) => x.allocation_id === msg.allocation_id);
        if (a) a.status = "confirmed";
        const rsv = state.reservations.find((x) => x.allocation_id === msg.allocation_id && x.status === "held");
        if (rsv) rsv.status = "committed";
      }
    }
    if (msg.message_type === "release" && device) device.current_dispatch_state = "idle";
    if (msg.message_type === "config_sync" && device) {
      device.config_status = "synced";
      device.config_synced_at = msg.ack_at;
    }
  } else {
    retryOrFail(msg);
  }
  save(state);
}

export function tickTimeouts(): Snapshot {
  const now = Date.now();
  for (const msg of [...state.messages]) {
    if (msg.status !== "pending") continue;
    const sent = Date.parse(msg.sent_at);
    if (now - sent < msg.timeout_seconds * 1000) continue;
    msg.status = "timed_out";
    retryOrFail(msg);
  }
  const expiredEvents = new Set<string>();
  for (const r of state.reservations) {
    if (r.status === "released") continue;
    if (Date.parse(r.held_until) > now) continue;
    const run = state.solver_runs.find((x) => x.run_id === r.run_id);
    if (run) expiredEvents.add(run.event_id);
    r.status = "released";
  }
  for (const eventId of expiredEvents) {
    const live = state.allocations.filter((a) => {
      const run = state.solver_runs.find((x) => x.run_id === a.run_id);
      return run?.event_id === eventId && ["sent", "confirmed", "pending"].includes(a.status);
    });
    if (live.length) releaseEvent(eventId, "event_complete");
  }
  for (const a of state.allocations) {
    if (a.status !== "confirmed" || a.delivered_kwh != null) continue;
    const rsv = state.reservations.find((r) => r.allocation_id === a.allocation_id);
    if (!rsv || Date.parse(rsv.held_until) > now) continue;
    const d = state.devices.find((x) => x.device_id === a.device_id);
    const dtH = Math.max(0, (Date.parse(rsv.held_until) - Date.parse(rsv.held_from)) / 3_600_000);
    a.delivered_kwh = Math.abs(d?.last_p_ac_kw ?? 0) * dtH;
  }
  save(state);
  return snap();
}

function retryOrFail(msg: ChannelMessage): void {
  const device = state.devices.find((d) => d.device_id === msg.device_id);
  if (!device) return;
  if (
    (msg.message_type === "dispatch_instruction" || msg.message_type === "setpoint_revision") &&
    msg.attempt_number <= MAX_DISPATCH_RETRIES
  ) {
    if (msg.allocation_id) {
      sendTyped(
        device,
        msg.event_id ?? "",
        msg.message_type,
        msg.payload,
        msg.allocation_id,
        msg.attempt_number + 1,
        msg.message_id,
      );
    } else {
      sendDispatch(device, msg.event_id ?? "", msg.payload, msg.attempt_number + 1, msg.message_id);
    }
    return;
  }
  if (msg.message_type === "config_sync" && msg.attempt_number <= MAX_CONFIG_RETRIES) {
    syncOne(device, msg.attempt_number + 1, msg.message_id);
    return;
  }
  if (msg.message_type === "dispatch_instruction" || msg.message_type === "setpoint_revision") {
    device.current_dispatch_state = "failed";
    if (msg.allocation_id) {
      const a = state.allocations.find((x) => x.allocation_id === msg.allocation_id);
      if (a) a.status = "failed";
      for (const r of state.reservations) {
        if (r.allocation_id === msg.allocation_id) r.status = "released";
      }
      reallocate(a ?? null);
    }
  } else if (msg.message_type === "release") {
    device.current_dispatch_state = "idle";
  } else device.config_status = "failed";
}

function syncOne(device: Device, attempt = 1, retryOf: string | null = null): void {
  const now = new Date().toISOString();
  const payload = String(device.reserve_bound_pct);
  const msg: ChannelMessage = {
    message_id: nid("msg"),
    device_id: device.device_id,
    event_id: null,
    message_type: "config_sync",
    payload,
    status: "pending",
    sent_at: now,
    ack_at: null,
    timeout_seconds: CONFIG_TIMEOUT,
    attempt_number: attempt,
    retry_of_message_id: retryOf,
    allocation_id: null,
  };
  state.messages.unshift(msg);
  const d = state.devices.find((x) => x.device_id === device.device_id);
  if (d) d.config_status = "pending";
  const ch = state.channels.find((c) => c.channel_id === device.channel_id);
  if (ch) {
    state.sends.unshift({
      send_id: nid("snd"),
      channel_id: ch.channel_id,
      channel_type: ch.channel_type,
      endpoint: ch.endpoint,
      instruction_text: `FAILSAFE_RESERVE ${payload}`,
      attempted_at: now,
    });
  }
  scheduleSim(device, msg);
  save(state);
}

export function syncConfig(deviceId?: string): Snapshot {
  const targets = deviceId
    ? state.devices.filter((d) => d.device_id === deviceId)
    : state.devices.filter((d) => ["unsynced", "stale", "failed"].includes(d.config_status));
  for (const d of targets) syncOne(d);
  return snap();
}

export function setSim(deviceId: string, sim: Device["sim"]): Snapshot {
  const d = state.devices.find((x) => x.device_id === deviceId);
  if (d) d.sim = sim;
  save(state);
  return snap();
}

export function seedTelemetry(): Snapshot {
  const now = new Date().toISOString();
  const samples: Record<string, [number, number]> = {
    dev_jay_batt: [82, 0.2],
    dev_kora_batt: [76, 0],
    dev_and_batt: [88, -0.4],
    dev_pune_batt: [70, 0.1],
    dev_ady_batt: [85, 0],
  };
  for (const [id, [soc, p]] of Object.entries(samples)) {
    const d = state.devices.find((x) => x.device_id === id);
    if (!d) continue;
    d.last_soc_pct = soc;
    d.last_p_ac_kw = p;
    d.last_telemetry_at = now;
    state.telemetry.unshift({
      sample_id: nid("tel"),
      device_id: id,
      observed_at: now,
      ingested_at: now,
      soc_pct: soc,
      p_ac_kw: p,
      source: "poll",
    });
  }
  save(state);
  return snap();
}

export function releaseEvent(eventId: string, reason = "event_cancelled"): Snapshot {
  const event = state.dispatch_log.find((e) => e.event_id === eventId);
  if (!event) return snap();
  for (const a of state.allocations.filter((x) => {
    const run = state.solver_runs.find((r) => r.run_id === x.run_id);
    return run?.event_id === eventId && ["sent", "confirmed", "pending"].includes(x.status);
  })) {
    const device = state.devices.find((d) => d.device_id === a.device_id);
    if (device) {
      sendTyped(device, event.event_id, "release", JSON.stringify({ allocation_id: a.allocation_id, reason }), a.allocation_id);
    }
    a.status = "released";
  }
  for (const r of state.reservations) {
    const run = state.solver_runs.find((x) => x.run_id === r.run_id);
    if (run?.event_id === eventId) r.status = "released";
  }
  save(state);
  return snap();
}

function hasInFlight(deviceId: string): boolean {
  return state.messages.some((m) => m.device_id === deviceId && m.status === "pending");
}

function liveReservedKw(deviceId: string): number {
  return state.reservations
    .filter((r) => r.device_id === deviceId && (r.status === "held" || r.status === "committed"))
    .reduce((n, r) => n + r.reserved_kw, 0);
}

function deadReckon(d: Device, cap: DeviceCapability, t0: number): number {
  let soc = d.last_soc_pct ?? 0;
  if (!d.last_telemetry_at || d.last_p_ac_kw == null) return soc;
  const dtH = Math.max(0, (t0 - Date.parse(d.last_telemetry_at)) / 3_600_000);
  const p = d.last_p_ac_kw;
  const e = cap.energy_capacity_kwh;
  if (e <= 0 || dtH === 0) return soc;
  if (p >= 0) soc -= ((p * dtH) / (cap.eta_discharge * e)) * 100;
  else soc += (((-p) * dtH * cap.eta_charge) / e) * 100;
  return Math.max(cap.soc_min_pct, Math.min(cap.soc_max_pct, soc));
}

function reallocate(failed: DeviceAllocation | null): void {
  if (!failed) return;
  const run = state.solver_runs.find((r) => r.run_id === failed.run_id);
  if (!run || run.run_number >= MAX_REALLOCATIONS) return;
  const event = state.dispatch_log.find((e) => e.event_id === run.event_id);
  const rule = state.rules.find((r) => r.rule_id === event?.rule_id);
  if (!event || !rule || rule.instruction_type !== "fleet_target") return;
  const committed = state.allocations
    .filter((a) => {
      const rr = state.solver_runs.find((x) => x.run_id === a.run_id);
      return rr?.event_id === event.event_id && (a.status === "sent" || a.status === "confirmed");
    })
    .reduce((n, a) => n + Math.abs(a.p_setpoint_kw), 0);
  const residual = Math.abs(rule.target_kw ?? 0) - committed;
  if (residual < 0.01) return;
  const sign = (rule.target_kw ?? 0) >= 0 ? 1 : -1;
  allocateEvent(event, { ...rule, target_kw: residual * sign }, new Date().toISOString());
  if (state.solver_runs[0]) state.solver_runs[0].run_number = run.run_number + 1;
}

export function setOptOut(deviceId: string, until: string | null): Snapshot {
  const d = state.devices.find((x) => x.device_id === deviceId);
  if (d) d.opt_out_until = until;
  save(state);
  return snap();
}

function liveReservedEnergy(deviceId: string): number {
  return state.reservations
    .filter((r) => r.device_id === deviceId && (r.status === "held" || r.status === "committed"))
    .reduce((n, r) => n + r.reserved_energy_kwh, 0);
}

function allocateEvent(event: DispatchEvent, rule: ThresholdRule, now: string): string[] {
  const R = Math.abs(rule.target_kw ?? 0);
  const durationMin = rule.duration_min ?? 30;
  const durationH = durationMin / 60;
  const expires = new Date(Date.parse(now) + durationMin * 60_000).toISOString();
  const list = state.lists.find((l) => l.list_id === rule.list_id);
  const eligible: { d: Device; cap: DeviceCapability; pbar: number; soc: number; floor: number; bind: string }[] = [];
  for (const id of list?.device_ids ?? []) {
    const d = state.devices.find((x) => x.device_id === id);
    const cap = state.capabilities.find((c) => c.device_id === id);
    if (!d || !cap) continue;
    if (d.device_status !== "active" || d.config_status !== "synced") continue;
    if (hasInFlight(d.device_id)) continue;
    if (d.opt_out_until && Date.parse(d.opt_out_until) > Date.parse(now)) continue;
    const failedThis = state.allocations.some((a) => {
      const rr = state.solver_runs.find((x) => x.run_id === a.run_id);
      return rr?.event_id === event.event_id && a.device_id === id && a.status === "failed";
    });
    if (failedThis) continue;
    if (!d.last_telemetry_at || Date.now() - Date.parse(d.last_telemetry_at) > TELEMETRY_STALE_MS) continue;
    const site = state.sites.find((s) => s.site_id === d.site_id);
    const floor = Math.max(cap.soc_min_pct, d.reserve_bound_pct, site?.contract_floor_soc_pct ?? 0);
    const soc = deadReckon(d, cap, Date.parse(now));
    const discharge = (rule.target_kw ?? 0) >= 0;
    let energy = discharge
      ? cap.energy_capacity_kwh * Math.max(0, soc - floor) / 100
      : cap.energy_capacity_kwh * Math.max(0, cap.soc_max_pct - soc) / 100;
    energy -= liveReservedEnergy(d.device_id);
    const sKw = discharge
      ? cap.eta_discharge * Math.max(0, energy) / durationH
      : Math.max(0, energy) / (cap.eta_charge * durationH);
    const pMax = discharge ? cap.p_discharge_max_kw : cap.p_charge_max_kw;
    let pbar = Math.max(0, Math.min(pMax - Math.abs(liveReservedKw(d.device_id)), sKw));
    const limit = discharge ? site?.export_limit_kw : site?.import_limit_kw;
    const g = limit == null ? Infinity : Math.max(0, limit);
    let bind = sKw < pMax ? "energy" : "power";
    if (g < Infinity && pbar > g) {
      pbar = g;
      bind = "site";
    }
    eligible.push({ d, cap, pbar, soc, floor, bind });
  }
  const headroom = eligible.reduce((n, e) => n + e.pbar, 0);
  const lam = headroom > 0 ? Math.min(1, R / headroom) : 0;
  const sent: string[] = [];
  const run: SolverRun = {
    run_id: nid("run"),
    event_id: event.event_id,
    run_number: 1,
    solved_at: now,
    target_kw: rule.target_kw ?? 0,
    eligible_count: eligible.length,
    total_headroom_kw: headroom,
    allocated_kw: 0,
    shortfall_kw: 0,
    lambda: lam,
    sites_binding_count: eligible.filter((e) => e.bind === "site").length,
    quantization_loss_kw: 0,
    status: eligible.length ? "optimal" : "no_eligible_devices",
  };
  let allocated = 0;
  for (const e of eligible) {
    const raw = e.pbar * lam;
    const step = e.cap.setpoint_step_kw || 0.1;
    const p = Math.floor(raw / step) * step;
    if (p < 0.01) continue;
    const signed = (rule.target_kw ?? 0) >= 0 ? p : -p;
    allocated += p;
    const alloc: DeviceAllocation = {
      allocation_id: nid("alloc"),
      run_id: run.run_id,
      device_id: e.d.device_id,
      capability_version: e.cap.capability_version,
      soc_at_solve_pct: e.soc,
      floor_soc_pct: e.floor,
      headroom_kw: e.pbar,
      p_setpoint_kw: signed,
      p_setpoint_raw_kw: (rule.target_kw ?? 0) >= 0 ? raw : -raw,
      expected_energy_kwh: (p * durationH) / e.cap.eta_discharge,
      binding_constraint: e.bind,
      status: "sent",
      delivered_kwh: null,
    };
    state.allocations.unshift(alloc);
    const rsv: HeadroomReservation = {
      reservation_id: nid("rsv"),
      device_id: e.d.device_id,
      site_id: e.d.site_id,
      run_id: run.run_id,
      allocation_id: alloc.allocation_id,
      reserved_kw: signed,
      reserved_energy_kwh: alloc.expected_energy_kwh,
      held_from: now,
      held_until: expires,
      status: "held",
    };
    state.reservations.unshift(rsv);
    const payload = JSON.stringify({ p_setpoint_kw: signed, duration_min: durationMin, expires_at: expires });
    sendTyped(e.d, event.event_id, "dispatch_instruction", payload, alloc.allocation_id);
    sent.push(e.d.device_id);
  }
  run.allocated_kw = allocated;
  run.shortfall_kw = Math.max(0, R - allocated);
  run.status = eligible.length === 0 ? "no_eligible_devices" : run.shortfall_kw > 0.05 ? "degraded" : "optimal";
  state.solver_runs.unshift(run);
  return sent;
}

function sendTyped(
  device: Device,
  eventId: string,
  messageType: ChannelMessage["message_type"],
  payload: string,
  allocationId: string | null,
  attempt = 1,
  retryOf: string | null = null,
): void {
  const now = new Date().toISOString();
  const msg: ChannelMessage = {
    message_id: nid("msg"),
    device_id: device.device_id,
    event_id: eventId,
    message_type: messageType,
    payload,
    status: "pending",
    sent_at: now,
    ack_at: null,
    timeout_seconds: messageType === "release" ? 2 : ACK_TIMEOUT,
    attempt_number: attempt,
    retry_of_message_id: retryOf,
    allocation_id: allocationId,
  };
  state.messages.unshift(msg);
  if (messageType !== "release") {
    const d = state.devices.find((x) => x.device_id === device.device_id);
    if (d) d.current_dispatch_state = "dispatched";
  }
  const chn = state.channels.find((c) => c.channel_id === device.channel_id);
  if (chn) {
    state.sends.unshift({
      send_id: nid("snd"),
      channel_id: chn.channel_id,
      channel_type: chn.channel_type,
      endpoint: chn.endpoint,
      instruction_text: payload,
      attempted_at: now,
    });
  }
  scheduleSim(device, msg);
}

function site(
  site_id: string,
  customer_id: string,
  utility_territory: string,
  contract_floor_soc_pct: number | null = null,
  export_limit_kw: number | null = null,
  import_limit_kw: number | null = null,
  site_headroom_source = "assumed_default",
): Site {
  return {
    site_id,
    customer_id,
    utility_territory,
    contract_floor_soc_pct,
    export_limit_kw,
    import_limit_kw,
    site_headroom_source,
  };
}

function cap(device_id: string, energy: number, pdis: number, pchg: number): DeviceCapability {
  return {
    device_id,
    energy_capacity_kwh: energy,
    p_discharge_max_kw: pdis,
    p_charge_max_kw: pchg,
    eta_discharge: 0.95,
    eta_charge: 0.95,
    soc_min_pct: 5,
    soc_max_pct: 95,
    control_mode: "continuous",
    setpoint_step_kw: 0.1,
    capability_version: 1,
  };
}
function ch(channel_id: string, channel_type: string, endpoint: string): Channel {
  return { channel_id, channel_type, endpoint };
}
function dev(
  device_id: string,
  site_id: string,
  channel_id: string,
  device_class: string,
  rated_capacity_kw: number,
  reserve_bound_pct: number,
  device_status: Device["device_status"] = "active",
): Device {
  return {
    device_id,
    site_id,
    channel_id,
    device_class,
    rated_capacity_kw,
    reserve_bound_pct,
    device_status,
    current_dispatch_state: "idle",
    config_status: "unsynced",
    config_synced_at: null,
    last_soc_pct: null,
    last_p_ac_kw: null,
    last_telemetry_at: null,
    opt_out_until: null,
    sim: device_id === "dev_pune_batt" ? "nack_then_ack" : device_id === "dev_ady_batt" ? "timeout" : "ack",
  };
}

function upsert<T extends Record<string, unknown>>(rows: T[], key: keyof T, row: T): void {
  const i = rows.findIndex((r) => r[key] === row[key]);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
}
