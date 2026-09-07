import { useMemo, useRef, useState } from "react";
import { api } from "./api";
import { configClass, dispatchClass, messageClass } from "./status";
import type { SignalResult, Snapshot } from "./types";

type Step = {
  t: string;
  title: string;
  body: string;
  expect: string;
} & (
  | { kind: "setup" }
  | { kind: "config_sync" }
  | { kind: "telemetry" }
  | { kind: "signal"; source: string; value: number; signal_id: string }
  | { kind: "pause"; device_id: string }
  | { kind: "opt_out"; device_id: string }
  | { kind: "deactivate"; rule_id: string }
  | { kind: "arm_overlap" }
);

const STUDY: Step[] = [
  {
    kind: "setup",
    t: "09:50",
    title: "Reset the study fleet",
    body: "Five sites with export limits. Five batteries have DEVICE_CAPABILITY. Peak rule is now a fleet_target of 15 kW for 30 min — not a fixed string.",
    expect: "Inventory loaded. config unsynced, no telemetry yet, no slack.",
  },
  {
    kind: "config_sync",
    t: "09:55",
    title: "Push failsafe reserve bounds",
    body: "L2 will not allocate to a device whose failsafe is not synced. Config sync still runs on L1's channel.",
    expect: "Most devices synced. Adyar may fail; it stays out of the eligible set.",
  },
  {
    kind: "telemetry",
    t: "09:58",
    title: "Fresh telemetry lands",
    body: "L2 will not allocate against a SoC it cannot trust. Stale devices are excluded. This ingest writes TELEMETRY_SAMPLE and refreshes last_soc_pct.",
    expect: "Batteries have last_soc_pct. Eligible set can form.",
  },
  {
    kind: "signal",
    t: "10:00",
    title: "Morning forecast is quiet",
    body: "forecast_peak prints 0.62. The peak-shave rule is armed at > 0.85, so this is a miss. No DISPATCH_LOG row, no CHANNEL_MESSAGE.",
    expect: "No Channel.send. No DISPATCH_LOG.",
    source: "forecast_peak",
    value: 0.62,
    signal_id: "sig_study_1000",
  },
  {
    kind: "signal",
    t: "12:30",
    title: "Load is climbing",
    body: "0.80 still sits under the threshold. Same rule, different signal_id — still a miss, not a duplicate.",
    expect: "Still no fire.",
    source: "forecast_peak",
    value: 0.8,
    signal_id: "sig_study_1230",
  },
  {
    kind: "signal",
    t: "15:00",
    title: "Peak crosses",
    body: "0.91 > 0.85. The solver splits 15 kW across eligible batteries. Jayanagar is export-capped at 4 kW. Setpoints go out as structured CHANNEL_MESSAGE payloads.",
    expect: "SOLVER_RUN + DEVICE_ALLOCATION rows. Jay ≤ 4 kW. Reservations held.",
    source: "forecast_peak",
    value: 0.91,
    signal_id: "sig_study_1500",
  },
  {
    kind: "signal",
    t: "15:00",
    title: "Duplicate telemetry",
    body: "The same signal_id arrives again (a replayed forecast tick). (rule_id, signal_id) is already on DISPATCH_LOG, so the loop skips. Without that unique index L1 would arm two racing ack timers.",
    expect: "skipped_duplicate. No new sends.",
    source: "forecast_peak",
    value: 0.91,
    signal_id: "sig_study_1500",
  },
  {
    kind: "opt_out",
    t: "15:20",
    title: "Pune battery opts out",
    body: "Customer opt-out (opt_out_until) is not pause and not un-enrolment. L2 drops Pune from the eligible set, so its slack is not counted.",
    expect: "dev_pune_batt opted out. Still active.",
    device_id: "dev_pune_batt",
  },
  {
    kind: "signal",
    t: "16:00",
    title: "Second peak print",
    body: "A new signal_id, still above threshold. Four batteries are sent; Pune is on the list but not active, so it is skipped.",
    expect: "Fire again. Pune opted out so its slack is not in the solve.",
    source: "forecast_peak",
    value: 0.94,
    signal_id: "sig_study_1600",
  },
  {
    kind: "signal",
    t: "17:00",
    title: "DISCOM calls",
    body: "discom_call = 1 meets >= 1. HVAC list gets CURTAIL HVAC on active thermostats.",
    expect: "rul_discom_call fires. 3 HVAC sends.",
    source: "discom_call",
    value: 1,
    signal_id: "sig_study_1700",
  },
  {
    kind: "deactivate",
    t: "17:10",
    title: "Retire the HVAC rule",
    body: "is_active=false. The row stays so DISPATCH_LOG history is not orphaned. The rule simply no longer matches.",
    expect: "rul_discom_call inactive.",
    rule_id: "rul_discom_call",
  },
  {
    kind: "signal",
    t: "17:40",
    title: "DISCOM calls again",
    body: "New signal_id, same source and value. No active rule matches. Nothing is sent.",
    expect: "No matching active rule.",
    source: "discom_call",
    value: 1,
    signal_id: "sig_study_1740",
  },
  {
    kind: "arm_overlap",
    t: "18:00",
    title: "Arm an overlapping peak rule",
    body: "A higher-priority rule (priority 5) on the same battery list, different instruction. Order is now defined; both can still fire.",
    expect: "rul_forecast_peak_hi armed at priority 5.",
  },
  {
    kind: "signal",
    t: "18:15",
    title: "Evening peak, two rules",
    body: "Both active peak rules cross. They run in priority order: DISCHARGE 1.0 PU first, then DISCHARGE 0.5 PU. Pune still paused.",
    expect: "Two dispatch rows. 4 + 4 sends, Pune excluded both times.",
    source: "forecast_peak",
    value: 0.96,
    signal_id: "sig_study_1815",
  },
];

export function Demo({
  data,
  onRefresh,
  onResult,
}: {
  data: Snapshot;
  onRefresh: () => Promise<void>;
  onResult: (r: SignalResult | null) => void;
}) {
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [hit, setHit] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [last, setLast] = useState<SignalResult | null>(null);
  const playRef = useRef(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const step = idx >= 0 ? STUDY[idx] : null;
  const channels = useMemo(
    () => Object.fromEntries(data.channels.map((c) => [c.channel_id, c])),
    [data.channels],
  );

  const runStep = async (i: number) => {
    const s = STUDY[i];
    setBusy(true);
    try {
      if (s.kind === "setup") {
        await api.seed();
        onResult(null);
        setLast(null);
        setHit([]);
        setLog(["Study fleet reset. config unsynced, dispatch idle."]);
      } else if (s.kind === "config_sync") {
        await api.configSync();
        setLog((prev) => [`${s.t}  config sync in flight`, ...prev].slice(0, 14));
      } else if (s.kind === "telemetry") {
        await api.telemetrySeed();
        setLog((prev) => [`${s.t}  telemetry ingested`, ...prev].slice(0, 14));
      } else if (s.kind === "signal") {
        const r = await api.signal(s.source, s.value, s.signal_id);
        setLast(r);
        onResult(r);
        const sent = r.trace.flatMap((t) => t.device_ids);
        setHit(sent);
        const bits = [
          r.skipped_duplicate ? "duplicate skipped" : r.fired_event_ids.length ? `fired ${r.fired_event_ids.length}` : "no fire",
          `${sent.length} send${sent.length === 1 ? "" : "s"}`,
        ];
        setLog((prev) => [`${s.t}  ${s.source}=${s.value}  ${bits.join(" · ")}`, ...prev].slice(0, 14));
      } else if (s.kind === "opt_out") {
        await api.setOptOut(s.device_id, new Date(Date.now() + 4 * 3600_000).toISOString());
        setHit([]);
        setLog((prev) => [`${s.t}  opt-out ${s.device_id}`, ...prev].slice(0, 14));
      } else if (s.kind === "pause") {
        const d = (await api.snapshot()).devices.find((x) => x.device_id === s.device_id);
        if (d) await api.createDevice({ ...d, device_status: "paused" });
        setHit([]);
        setLog((prev) => [`${s.t}  paused ${s.device_id}`, ...prev].slice(0, 14));
      } else if (s.kind === "deactivate") {
        const r = (await api.snapshot()).rules.find((x) => x.rule_id === s.rule_id);
        if (r) await api.createRule({ ...r, is_active: false });
        setHit([]);
        setLog((prev) => [`${s.t}  deactivated ${s.rule_id}`, ...prev].slice(0, 14));
      } else if (s.kind === "arm_overlap") {
        await api.createRule({
          rule_id: "rul_forecast_peak_hi",
          signal_source: "forecast_peak",
          comparator: ">",
          threshold_value: 0.85,
          list_id: "lst_peak_batteries",
          fixed_instruction: "DISCHARGE 1.0 PU",
          priority: 5,
          is_active: true,
        });
        setHit([]);
        setLog((prev) => [`${s.t}  armed overlapping peak rule pri 5`, ...prev].slice(0, 14));
      }
      await onRefresh();
      setIdx(i);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    playRef.current = true;
    setPlaying(true);
    await runStep(0);
    for (let i = 1; i < STUDY.length; i++) {
      if (!playRef.current) return;
      await new Promise((r) => setTimeout(r, 2200 / speedRef.current));
      if (!playRef.current) return;
      await runStep(i);
    }
    playRef.current = false;
    setPlaying(false);
  };

  const stepOnce = async () => {
    setPlaying(false);
    const next = idx + 1;
    if (next >= STUDY.length) return;
    await runStep(next);
  };

  return (
    <>
      <p className="kicker">L2 · live study</p>
      <h1>Peak-day demo</h1>
      <p className="lede">
        Watch allocation: config sync, telemetry, then a 15 kW fleet target
        split by slack. device_status, dispatch state, and setpoint stay
        separate.
      </p>

      <div className="demo-bar">
        <div className="demo-clock mono">{step?.t ?? "—:—"}</div>
        <div className="demo-progress">
          <div
            className="demo-progress-fill"
            style={{ width: `${idx < 0 ? 0 : ((idx + 1) / STUDY.length) * 100}%` }}
          />
        </div>
        <span className="muted">
          {idx < 0 ? "ready" : `${idx + 1} / ${STUDY.length}`}
        </span>
        <div className="actions" style={{ margin: 0 }}>
          <button className="btn primary" disabled={busy} onClick={() => void start()}>
            {idx >= STUDY.length - 1 && !playing ? "Replay" : "Play study"}
          </button>
          <button className="btn" disabled={busy || playing} onClick={() => void stepOnce()}>
            Step
          </button>
          <button
            className="btn"
            disabled={!playing}
            onClick={() => {
              playRef.current = false;
              setPlaying(false);
            }}
          >
            Pause
          </button>
          {([1, 2, 4] as const).map((n) => (
            <button
              key={n}
              className={`btn ${speed === n ? "primary" : ""}`}
              onClick={() => setSpeed(n)}
            >
              {n}×
            </button>
          ))}
        </div>
      </div>

      <div className="demo-grid">
        <div className="panel">
          <h2>Fleet reaction</h2>
          <div className="demo-devices">
            {data.devices.map((d) => {
              const ch = channels[d.channel_id];
              const on = hit.includes(d.device_id);
              return (
                <article
                  key={d.device_id}
                  className={`demo-device ${on ? "hit" : ""} ${d.device_status !== "active" ? "off" : ""}`}
                >
                  <header>
                    <span className="dot" data-class={d.device_class} />
                    <span className="mono">{d.device_id}</span>
                  </header>
                  <div className="muted">
                    {d.device_class} · {ch?.channel_type ?? "—"}
                  </div>
                  <span className={d.device_status === "active" ? "pill green" : "pill"}>
                    {d.device_status}
                  </span>
                  <span className={dispatchClass(d.current_dispatch_state)}>
                    {d.current_dispatch_state}
                  </span>
                  <span className={configClass(d.config_status)}>{d.config_status}</span>
                  {on ? <span className="pill amber">sent</span> : null}
                </article>
              );
            })}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h2>{step ? step.title : "Waiting to start"}</h2>
            <p className="orch-copy">{step ? step.body : "Press Play study or Step to reset the fleet and walk the day."}</p>
            {step ? (
              <p>
                <span className="pill amber">expect</span> {step.expect}
              </p>
            ) : null}
            {last ? (
              <div className="demo-outcome">
                <div className="mono">
                  {last.signal.source} = {last.signal.value} · {last.signal.signal_id}
                </div>
                {last.trace.map((t) => (
                  <div key={t.rule_id}>
                    <span className="mono">{t.rule_id}</span>{" "}
                    {t.skipped_duplicate ? (
                      <span className="pill">duplicate skip</span>
                    ) : t.crossed ? (
                      <span className="pill amber">fired · {t.device_ids.length} send</span>
                    ) : (
                      <span className="pill">no cross</span>
                    )}
                  </div>
                ))}
                {last.trace.length === 0 ? <p className="empty">No active matching rules.</p> : null}
              </div>
            ) : null}
          </div>
          <div className="panel">
            <h2>CHANNEL_MESSAGE</h2>
            <ol className="demo-tape">
              {data.messages.slice(0, 10).map((m) => (
                <li key={m.message_id} className="mono">
                  {m.message_type} · {m.device_id} ·{" "}
                  <span className={messageClass(m.status)}>{m.status}</span> · try {m.attempt_number}
                </li>
              ))}
            </ol>
          </div>
          <div className="panel">
            <h2>Study tape</h2>
            <ol className="demo-tape">
              {log.map((line, i) => (
                <li key={`${line}-${i}`} className="mono">
                  {line}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Script</h2>
        <div className="demo-script">
          {STUDY.map((s, i) => (
            <button
              key={`${s.t}-${s.title}`}
              className={`demo-chip ${i === idx ? "on" : ""} ${i < idx ? "done" : ""}`}
              disabled={busy || playing}
              onClick={() => void runStep(i)}
            >
              <span className="mono">{s.t}</span>
              {s.title}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
