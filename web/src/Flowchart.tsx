import { useId } from "react";
import type { SignalResult, Snapshot } from "./types";

type NodeState = "idle" | "hot" | "miss" | "skip";

export function FlowchartPage({
  data,
  result,
}: {
  data: Snapshot;
  result: SignalResult | null;
}) {
  return (
    <>
      <p className="kicker">L2 · how it runs</p>
      <h1>Flowchart</h1>
      <p className="lede">
        A <code>fleet_target</code> rule no longer broadcasts the same string.
        L2 builds an eligible set (active, synced, fresh telemetry, not
        in-flight), computes slack net of reservations, solves an equal-stress
        QP, then hands each setpoint to L1&apos;s channel.
      </p>
      {result ? (
        <p className="last-fire">
          Last injected signal{" "}
          <span className="mono">
            {result.signal.source} = {result.signal.value} ({result.signal.signal_id})
          </span>
          {result.skipped_duplicate
            ? " · duplicate signal_id skipped"
            : result.fired_event_ids.length
              ? ` · fired ${result.fired_event_ids.length} rule${result.fired_event_ids.length === 1 ? "" : "s"}`
              : " · no rule crossed"}
          . Highlighted path is that pass.
        </p>
      ) : (
        <p className="muted" style={{ marginTop: -12, marginBottom: 18 }}>
          Inject a signal on the Signals tab to light up the dispatch path this
          process just took.
        </p>
      )}

      <div className="panel flow-panel">
        <h2>Dispatch loop</h2>
        <RuntimeFlow data={data} result={result} />
      </div>

      <div className="panel flow-panel">
        <h2>Config sync loop — independent of dispatch</h2>
        <ConfigSyncFlow data={data} />
      </div>

      <div className="row">
        <div className="panel flow-panel">
          <h2>Registry — who exists, plus delivery state</h2>
          <RegistryFlow data={data} />
        </div>
        <div className="panel flow-panel">
          <h2>Stack — what L1 is not</h2>
          <LayerStack />
        </div>
      </div>
    </>
  );
}

export function CompactFlow({
  data,
  result,
  bare = false,
}: {
  data: Snapshot;
  result: SignalResult | null;
  bare?: boolean;
}) {
  const st = states(data, result);
  const mid = useMarkerId();
  const sendN = result
    ? result.trace.filter((t) => t.crossed).reduce((n, t) => n + t.device_ids.length, 0)
    : data.messages.filter((m) => m.message_type === "dispatch_instruction").length;
  const body = (
    <>
      <div className="flow-scroll">
        <svg viewBox="0 0 1120 150" className="flow-svg compact" role="img" aria-label="L1 dispatch strip">
          <ArrowHead id={mid} />
          <Node x={8} y={36} w={150} h={78} kicker="1" title="Incoming signal" sub="source, value" state={st.signal} />
          <HArrow id={mid} x1={158} y={75} x2={186} />
          <Node x={186} y={36} w={150} h={78} kicker="2" title="Match rules" sub={`${data.rules.length} armed`} state={st.match} />
          <HArrow id={mid} x1={336} y={75} x2={364} label="same source" />
          <Node x={364} y={36} w={150} h={78} kicker="3" title="Compare" sub="value ? threshold" state={st.compare} />
          <HArrow id={mid} x1={514} y={75} x2={542} label="crossed" />
          <Node x={542} y={36} w={150} h={78} kicker="4" title="Eligible slack" sub="SoC · floor · site cap" state={st.list} />
          <HArrow id={mid} x1={692} y={48} x2={720} />
          <HArrow id={mid} x1={692} y={102} x2={720} />
          <Node x={720} y={8} w={168} h={58} kicker="5a" title="QP setpoints" sub={`${sendN} · p_i kW`} state={st.send} />
          <Node x={720} y={80} w={168} h={58} kicker="5b" title="Reservation" sub="held before send" state={st.log} />
          <Node x={908} y={36} w={196} h={78} kicker="miss" title="No-op" sub="write nothing" state={st.skip} />
          <path
            d="M514 75 C514 75 514 18 1006 18 L1006 36"
            fill="none"
            className="flow-line"
            markerEnd={`url(#${mid})`}
          />
        </svg>
      </div>
      <p className="unread">
        Miss path writes nothing. Hit path writes DISPATCH_LOG first, then one
        pending CHANNEL_MESSAGE per reachable device. Timeout watcher only
        claims rows still pending.
      </p>
    </>
  );
  if (bare) return body;
  return (
    <div className="panel flow-panel">
      <h2>How a fire works</h2>
      {body}
    </div>
  );
}

export function RuntimeFlow({
  data,
  result,
}: {
  data: Snapshot;
  result: SignalResult | null;
}) {
  const st = states(data, result);
  const mid = useMarkerId();
  const matched = result?.matching_rule_ids.length ?? data.rules.length;
  const crossed = result?.trace.filter((t) => t.crossed) ?? [];
  const sendN = crossed.reduce((n, t) => n + t.device_ids.length, 0);
  const sig = result
    ? `${result.signal.source}=${result.signal.value}`
    : "source, value, signal_id";
  const cmp = result?.trace[0]
    ? `${result.trace[0].comparator} ${result.trace[0].threshold_value}`
    : ">, >=, <, …";
  const listName = crossed[0]
    ? data.lists.find((l) => l.list_id === crossed[0].list_id)?.name ?? crossed[0].list_id
    : `${data.lists.length} lists`;
  const instr = crossed[0]?.fixed_instruction ?? "fixed_instruction";

  return (
    <div className="flow-scroll">
      <svg viewBox="0 0 720 980" className="flow-svg" role="img" aria-label="L1 dispatch flowchart">
        <ArrowHead id={mid} />

        <Node x={250} y={8} w={220} h={70} kicker="incoming" title="Signal" sub={sig} state={st.signal} />
        <VArrow id={mid} x={360} y1={78} y2={108} label="(rule_id, signal_id) unique" />

        <Node
          x={220}
          y={108}
          w={280}
          h={78}
          kicker="THRESHOLD_RULE"
          title="Active rules by priority"
          sub={result ? `${matched} matching` : `${data.rules.filter((r) => r.is_active).length} active`}
          state={st.match}
        />
        <VArrow id={mid} x={360} y1={186} y2={218} label="for each match" />

        <Diamond cx={360} cy={278} r={62} title="compare" sub={cmp} state={st.compare} />

        <path d="M298 278 H120 V340" className="flow-line" fill="none" markerEnd={`url(#${mid})`} />
        <text className="flow-label" x={200} y={268}>
          miss
        </text>
        <Node x={20} y={348} w={200} h={70} kicker="no-op" title="Write nothing" sub="no send, no log" state={st.skip} />

        <VArrow id={mid} x={360} y1={340} y2={384} label="crossed" />
        <Node
          x={230}
          y={384}
          w={260}
          h={70}
          kicker="DISPATCH_LOG"
          title="Audit row first"
          sub="before any Channel.send"
          state={st.log}
        />

        <VArrow id={mid} x={360} y1={454} y2={492} label="then fan-out" />
        <Node
          x={230}
          y={492}
          w={260}
          h={70}
          kicker="BROADCAST_LIST"
          title="Load the static list"
          sub={listName}
          state={st.list}
        />

        <VArrow id={mid} x={360} y1={562} y2={600} label="skip inactive / dispatched" />
        <Node
          x={150}
          y={600}
          w={420}
          h={78}
          kicker="CHANNEL_MESSAGE"
          title="pending + Channel.send(on_ack)"
          sub={`${result ? sendN : "N"} × "${instr}"`}
          state={st.send}
        />

        <VArrow id={mid} x={360} y1={678} y2={716} label="only if still pending" />
        <Node
          x={80}
          y={716}
          w={250}
          h={78}
          kicker="handle_ack"
          title="acked → completed"
          sub="current_dispatch_state"
          state={st.send}
        />
        <Node
          x={390}
          y={716}
          w={250}
          h={78}
          kicker="nack / timeout"
          title="retry_or_fail"
          sub="new row, attempt+1"
          state={st.send}
        />
        <path d="M330 755 H390" className="flow-line" fill="none" />

        <text className="flow-foot" x={360} y={850}>
          L1 answers: did it land? Race guard: handle_ack and timeout_watcher act only while pending.
        </text>
        <text className="flow-foot" x={360} y={872}>
          MAX_DISPATCH_RETRIES=2. Substitution when retries exhaust is L2.
        </text>
        <text className="flow-foot" x={360} y={894}>
          reserve_bound_pct is the config-sync payload — not slack, not merit order.
        </text>
      </svg>
    </div>
  );
}

export function ConfigSyncFlow({ data }: { data: Snapshot }) {
  const mid = useMarkerId();
  const unsynced = data.devices.filter((d) => d.config_status !== "synced").length;
  const synced = data.devices.filter((d) => d.config_status === "synced").length;
  const pending = data.messages.filter((m) => m.message_type === "config_sync" && m.status === "pending").length;
  return (
    <div className="flow-scroll">
      <svg viewBox="0 0 1120 140" className="flow-svg compact" role="img" aria-label="L1 config sync strip">
        <ArrowHead id={mid} />
        <Node
          x={16}
          y={28}
          w={200}
          h={78}
          kicker="DEVICE"
          title="unsynced / stale"
          sub={`${unsynced} need a push`}
        />
        <HArrow id={mid} x1={216} y={67} x2={250} label="independent of dispatch" />
        <Node
          x={250}
          y={28}
          w={220}
          h={78}
          kicker="CHANNEL_MESSAGE"
          title="config_sync pending"
          sub={`${pending} in flight · event_id null`}
        />
        <HArrow id={mid} x1={470} y={48} x2={510} />
        <HArrow id={mid} x1={470} y={86} x2={510} />
        <Node x={510} y={8} w={200} h={58} kicker="acked" title="synced" sub={`${synced} devices`} />
        <Node x={510} y={74} w={200} h={58} kicker="nack / timeout" title="retry_or_fail" sub="MAX_CONFIG_RETRIES=3" />
        <Node x={760} y={28} w={180} h={78} kicker="failsafe" title="reserve_bound_pct" sub="now read by L1" />
        <HArrow id={mid} x1={710} y={67} x2={760} />
        <Node x={960} y={28} w={140} h={78} kicker="human" title="failed" sub="retries exhausted" />
      </svg>
    </div>
  );
}

export function RegistryFlow({ data }: { data: Snapshot }) {
  const mid = useMarkerId();
  const msgN = data.messages.length;
  return (
    <div className="flow-scroll">
      <svg viewBox="0 0 520 500" className="flow-svg" role="img" aria-label="L1 registry relationships">
        <ArrowHead id={mid} />
        <Node x={20} y={16} w={150} h={58} kicker="SITE" title={`${data.sites.length} sites`} sub="territory" />
        <Node x={350} y={16} w={150} h={58} kicker="CHANNEL" title={`${data.channels.length} channels`} sub="type + endpoint" />
        <path d="M95 74 V110 H260" className="flow-line" fill="none" markerEnd={`url(#${mid})`} />
        <path d="M425 74 V110 H260" className="flow-line" fill="none" markerEnd={`url(#${mid})`} />
        <text className="flow-label" x={150} y={102}>
          hosts
        </text>
        <text className="flow-label" x={370} y={102}>
          reaches
        </text>
        <Node
          x={140}
          y={118}
          w={240}
          h={64}
          kicker="DEVICE"
          title={`${data.devices.length} devices`}
          sub="dispatch_state · config_status"
        />
        <VArrow id={mid} x={260} y1={182} y2={218} label="membership" />
        <Node x={150} y={218} w={220} h={64} kicker="BROADCAST_LIST" title={`${data.lists.length} lists`} sub="many-to-many" />
        <VArrow id={mid} x={260} y1={282} y2={318} label="targeted by" />
        <Node x={16} y={318} w={200} h={64} kicker="THRESHOLD_RULE" title={`${data.rules.length} rules`} sub="source ? threshold" />
        <HArrow id={mid} x1={216} y={350} x2={252} label="fires" />
        <Node x={252} y={318} w={248} h={64} kicker="DISPATCH_LOG" title={`${data.dispatch_log.length} events`} sub="rule-fire audit" />
        <VArrow id={mid} x={376} y1={382} y2={414} label="generates" />
        <Node
          x={150}
          y={414}
          w={220}
          h={64}
          kicker="CHANNEL_MESSAGE"
          title={`${msgN} messages`}
          sub="source of truth"
        />
      </svg>
    </div>
  );
}

export function LayerStack() {
  return (
    <div className="layers">
      <div className="layer ghost">
        <strong>L3</strong>
        <span>
          Forecasts, multi-period, time-varying floors and envelopes. Not built.
        </span>
      </div>
      <div className="layer here">
        <strong>L2</strong>
        <span>
          How much can each device give, and how should a fleet target be split?
          Equal-stress QP, site caps, reservations, release.
        </span>
      </div>
      <div className="layer done">
        <strong>L1</strong>
        <span>
          Did it land? Failsafe config sync. Ack / nack / timeout. Built; L2
          sends structured setpoints over the same channel.
        </span>
      </div>
      <div className="layer done">
        <strong>L0</strong>
        <span>
          Which devices exist, and how do we reach them? Threshold → static list
          → Channel.send. Built; L1 adds the return path.
        </span>
      </div>
    </div>
  );
}

function states(data: Snapshot, result: SignalResult | null): Record<string, NodeState> {
  if (result?.skipped_duplicate) {
    return {
      signal: "miss",
      match: "skip",
      compare: "skip",
      list: "skip",
      send: "skip",
      log: "skip",
      skip: "hot",
    };
  }
  if (!result) {
    return {
      signal: "idle",
      match: data.rules.length ? "idle" : "skip",
      compare: "idle",
      list: "idle",
      send: "idle",
      log: data.dispatch_log.length ? "idle" : "idle",
      skip: "idle",
    };
  }
  const anyMatch = result.matching_rule_ids.length > 0;
  const anyCross = result.trace.some((t) => t.crossed);
  return {
    signal: "hot",
    match: anyMatch ? "hot" : "miss",
    compare: anyCross ? "hot" : anyMatch ? "miss" : "skip",
    list: anyCross ? "hot" : "skip",
    send: anyCross ? "hot" : "skip",
    log: anyCross ? "hot" : "skip",
    skip: anyCross ? "idle" : "hot",
  };
}

function Node({
  x,
  y,
  w,
  h,
  kicker,
  title,
  sub,
  state = "idle",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  kicker?: string;
  title: string;
  sub?: string;
  state?: NodeState;
}) {
  const cx = x + w / 2;
  return (
    <g className={`flow-node ${state}`}>
      <rect x={x} y={y} width={w} height={h} rx={12} />
      {kicker ? (
        <text className="k" x={cx} y={y + 16}>
          {kicker}
        </text>
      ) : null}
      <text className="t" x={cx} y={kicker ? y + 36 : y + 28}>
        {title}
      </text>
      {sub ? (
        <text className="s" x={cx} y={y + h - 14}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Diamond({
  cx,
  cy,
  r,
  title,
  sub,
  state = "idle",
}: {
  cx: number;
  cy: number;
  r: number;
  title: string;
  sub?: string;
  state?: NodeState;
}) {
  const pts = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
  return (
    <g className={`flow-node ${state}`}>
      <polygon points={pts} />
      <text className="t" x={cx} y={cy - 4}>
        {title}
      </text>
      {sub ? (
        <text className="s" x={cx} y={cy + 14}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function useMarkerId(): string {
  return `m${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function ArrowHead({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" className="flow-head" />
      </marker>
    </defs>
  );
}

function VArrow({
  id,
  x,
  y1,
  y2,
  label,
}: {
  id: string;
  x: number;
  y1: number;
  y2: number;
  label?: string;
}) {
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} className="flow-line" markerEnd={`url(#${id})`} />
      {label ? (
        <text className="flow-label" x={x + 10} y={(y1 + y2) / 2 + 4}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

function HArrow({
  id,
  x1,
  y,
  x2,
  label,
}: {
  id: string;
  x1: number;
  y: number;
  x2: number;
  label?: string;
}) {
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} className="flow-line" markerEnd={`url(#${id})`} />
      {label ? (
        <text className="flow-label" x={(x1 + x2) / 2} y={y - 8}>
          {label}
        </text>
      ) : null}
    </g>
  );
}
