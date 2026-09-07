import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  DEVICE_LABEL,
  demandIndex,
  fetchLiveWeather,
  istClock,
  istNow,
  loadShape,
  modelledHz,
} from "./live";
import type { CityWx } from "./live";
import { configClass, dispatchClass, messageClass } from "./status";
import type { Device, DeviceAllocation, SignalResult, Snapshot } from "./types";

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
  | { kind: "opt_out"; device_id: string }
  | { kind: "deactivate"; rule_id: string }
  | { kind: "release" }
);

const STUDY: Step[] = [
  {
    kind: "setup",
    t: "09:50",
    title: "Reset the study fleet",
    body: "Five homes, five batteries. Peak rule is a 15 kW / 30 min fleet target — the solver will split it.",
    expect: "Empty tape. Failsafe unsynced. No SoC yet.",
  },
  {
    kind: "config_sync",
    t: "09:55",
    title: "Push the failsafe",
    body: "Each battery must ack FAILSAFE_RESERVE before L2 will trust it. Adyar is scripted to time out.",
    expect: "Most synced. Adyar may stay failed and drop out of the eligible set.",
  },
  {
    kind: "telemetry",
    t: "09:58",
    title: "SoC arrives",
    body: "Fresh TELEMETRY_SAMPLE on every battery. Stale devices cannot be allocated.",
    expect: "SoC bars fill. Eligible slack exists.",
  },
  {
    kind: "signal",
    t: "10:00",
    title: "Morning is quiet",
    body: "Demand index 0.62 sits under the 0.85 peak rule. Nothing is sent.",
    expect: "No solve. No messages.",
    source: "forecast_peak",
    value: 0.62,
    signal_id: "sig_study_1000",
  },
  {
    kind: "signal",
    t: "12:30",
    title: "Load is climbing",
    body: "0.80 still misses. A different signal_id, not a duplicate.",
    expect: "Still no fire.",
    source: "forecast_peak",
    value: 0.8,
    signal_id: "sig_study_1230",
  },
  {
    kind: "signal",
    t: "15:00",
    title: "Peak — solver splits 15 kW",
    body: "0.91 crosses. Watch the kW bars: Jayanagar is export-capped at 4 kW so it cannot take a full equal-stress share.",
    expect: "Setpoints land. Jay ≤ 4 kW. Reservations held.",
    source: "forecast_peak",
    value: 0.91,
    signal_id: "sig_study_1500",
  },
  {
    kind: "signal",
    t: "15:00",
    title: "Replay of the same tick",
    body: "Same signal_id again. Unique (rule, signal) skips it — no second solve, no racing acks.",
    expect: "duplicate skipped.",
    source: "forecast_peak",
    value: 0.91,
    signal_id: "sig_study_1500",
  },
  {
    kind: "opt_out",
    t: "15:20",
    title: "Pune customer opts out",
    body: "Not a pause, not un-enrolment. The battery stays on the list; L2 just will not count its slack.",
    expect: "Pune still active, opted out.",
    device_id: "dev_pune_batt",
  },
  {
    kind: "signal",
    t: "16:00",
    title: "Second peak, less slack",
    body: "New signal_id. Reservations from the first event plus Pune’s opt-out shrink the pool.",
    expect: "Smaller eligible set. Pune not in the split.",
    source: "forecast_peak",
    value: 0.94,
    signal_id: "sig_study_1600",
  },
  {
    kind: "signal",
    t: "17:00",
    title: "DISCOM calls HVAC",
    body: "A fixed L1 rule still exists for thermostats: same curtail string to every active HVAC.",
    expect: "Three HVAC messages.",
    source: "discom_call",
    value: 1,
    signal_id: "sig_study_1700",
  },
  {
    kind: "release",
    t: "17:30",
    title: "Release the event",
    body: "Withdraw setpoints. Reservations free. Devices go back to their own control.",
    expect: "release messages. Live reservations → 0.",
  },
];

const HINTS = [
  "play",
  "step",
  "peak",
  "peak 0.91",
  "discom",
  "opt-out pune",
  "release",
  "allocate 12",
  "help",
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
  const [cmd, setCmd] = useState("");
  const [clock, setClock] = useState(istClock);
  const [wx, setWx] = useState<CityWx[]>([]);
  const [wxNote, setWxNote] = useState("fetching live weather…");
  const playRef = useRef(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const cmdRef = useRef<HTMLInputElement>(null);

  const step = idx >= 0 ? STUDY[idx] : null;
  const ist = istNow();
  const temps = wx.map((c) => c.tempC).filter((t): t is number => t != null);
  const demand = demandIndex(ist.getHours(), ist.getMinutes(), temps);
  const hz = modelledHz(demand);
  const peakArmed = demand > 0.85;

  const sites = useMemo(
    () => Object.fromEntries(data.sites.map((s) => [s.site_id, s])),
    [data.sites],
  );
  const caps = useMemo(
    () => Object.fromEntries(data.capabilities.map((c) => [c.device_id, c])),
    [data.capabilities],
  );
  const latestByDevice = useMemo(() => {
    const m = new Map<string, DeviceAllocation>();
    for (const a of data.allocations) {
      if (!m.has(a.device_id)) m.set(a.device_id, a);
    }
    return m;
  }, [data.allocations]);
  const lastRun = data.solver_runs[0];
  const liveRsv = data.reservations.filter((r) => r.status !== "released").length;

  useEffect(() => {
    const id = window.setInterval(() => setClock(istClock()), 250);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      const rows = await fetchLiveWeather();
      if (stop) return;
      setWx(rows);
      const ok = rows.filter((r) => r.tempC != null);
      setWxNote(
        ok.length
          ? `Open-Meteo · ${ok.length} cities · IST`
          : "weather unreachable — using hour-of-day load only",
      );
    };
    void pull();
    const id = window.setInterval(() => void pull(), 5 * 60_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const pushLog = (line: string) => setLog((prev) => [line, ...prev].slice(0, 16));

  const runStep = async (i: number) => {
    const s = STUDY[i];
    setBusy(true);
    try {
      if (s.kind === "setup") {
        await api.seed();
        onResult(null);
        setLast(null);
        setHit([]);
        setLog(["fleet reset · failsafe unsynced · no SoC"]);
      } else if (s.kind === "config_sync") {
        await api.configSync();
        pushLog(`${s.t}  failsafe push in flight`);
      } else if (s.kind === "telemetry") {
        await api.telemetrySeed();
        pushLog(`${s.t}  telemetry ingested`);
      } else if (s.kind === "signal") {
        const r = await api.signal(s.source, s.value, s.signal_id);
        setLast(r);
        onResult(r);
        const sent = r.trace.flatMap((t) => t.device_ids);
        setHit(sent);
        pushLog(
          `${s.t}  ${s.source}=${s.value}  ${r.skipped_duplicate ? "duplicate skip" : r.fired_event_ids.length ? `fired ${r.fired_event_ids.length}` : "miss"}`,
        );
      } else if (s.kind === "opt_out") {
        await api.setOptOut(s.device_id, new Date(Date.now() + 4 * 3600_000).toISOString());
        setHit([]);
        pushLog(`${s.t}  opt-out ${s.device_id}`);
      } else if (s.kind === "deactivate") {
        const r = (await api.snapshot()).rules.find((x) => x.rule_id === s.rule_id);
        if (r) await api.createRule({ ...r, is_active: false });
        setHit([]);
        pushLog(`${s.t}  deactivated ${s.rule_id}`);
      } else if (s.kind === "release") {
        const ev = (await api.snapshot()).dispatch_log[0];
        if (ev) await api.release(ev.event_id);
        setHit([]);
        pushLog(`${s.t}  release latest event`);
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
      await new Promise((r) => setTimeout(r, 2000 / speedRef.current));
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

  const firePeak = async (value: number) => {
    const r = await api.signal("forecast_peak", value, `sig_live_${Date.now()}`);
    setLast(r);
    onResult(r);
    setHit(r.trace.flatMap((t) => t.device_ids));
    pushLog(`peak ${value.toFixed(2)}  ${r.fired_event_ids.length ? "solved" : "miss"}`);
    await onRefresh();
  };

  const runCommand = async (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    const [head, ...rest] = line.toLowerCase().split(/\s+/);
    const arg = rest.join(" ");
    setBusy(true);
    try {
      if (head === "help") {
        pushLog("commands: play step seed sync telemetry peak [n] discom opt-out <city> release allocate <kW>");
      } else if (head === "play") {
        void start();
      } else if (head === "step") {
        await stepOnce();
      } else if (head === "pause") {
        playRef.current = false;
        setPlaying(false);
      } else if (head === "seed" || head === "reset") {
        await runStep(0);
      } else if (head === "sync") {
        await api.configSync();
        pushLog("failsafe push");
        await onRefresh();
      } else if (head === "telemetry" || head === "soc") {
        await api.telemetrySeed();
        pushLog("telemetry ingested");
        await onRefresh();
      } else if (head === "peak") {
        const v = rest[0] != null ? Number(rest[0]) : demand;
        if (!Number.isFinite(v)) throw new Error("peak needs a number, or omit it to use live demand");
        await firePeak(v);
      } else if (head === "discom") {
        const r = await api.signal("discom_call", 1, `sig_live_${Date.now()}`);
        setLast(r);
        onResult(r);
        setHit(r.trace.flatMap((t) => t.device_ids));
        pushLog("discom_call=1");
        await onRefresh();
      } else if (head === "opt-out" || head === "optout") {
        const key = arg || "pune";
        const d = data.devices.find((x) => x.device_id.includes(key) || (DEVICE_LABEL[x.device_id]?.city.toLowerCase() ?? "").includes(key));
        if (!d) throw new Error(`no device matching "${key}"`);
        await api.setOptOut(d.device_id, new Date(Date.now() + 4 * 3600_000).toISOString());
        pushLog(`opt-out ${d.device_id}`);
        await onRefresh();
      } else if (head === "release") {
        const ev = data.dispatch_log[0];
        if (!ev) throw new Error("no event to release");
        await api.release(ev.event_id);
        pushLog(`released ${ev.event_id}`);
        await onRefresh();
      } else if (head === "allocate") {
        const kw = Number(rest[0]);
        if (!Number.isFinite(kw)) throw new Error("allocate <kW>");
        const rule = data.rules.find((r) => r.rule_id === "rul_forecast_peak");
        if (rule) {
          await api.createRule({ ...rule, instruction_type: "fleet_target", target_kw: kw, duration_min: rule.duration_min ?? 30 });
        }
        await firePeak(0.91);
        pushLog(`allocate ${kw} kW`);
      } else {
        pushLog(`unknown command: ${head}  (try help)`);
      }
    } catch (err) {
      pushLog(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setCmd("");
    }
  };

  const shape = Array.from({ length: 24 }, (_, h) => loadShape(h));

  return (
    <>
      <p className="kicker">L2 · live desk</p>
      <h1>Peak-day desk</h1>
      <p className="lede">
        IST clock and city temperatures are live. Demand and frequency are
        modelled from the hour plus heat — type a command or play the study.
      </p>

      <div className="live-strip">
        <div className="live-clock">
          <span className="kicker" style={{ margin: 0 }}>
            Asia/Kolkata
          </span>
          <strong className="mono">{clock}</strong>
        </div>
        <div className="live-metric">
          <span>Demand index</span>
          <b className="mono">{demand.toFixed(2)}</b>
          <span className={peakArmed ? "pill amber" : "pill"}>{peakArmed ? "above 0.85" : "under peak rule"}</span>
        </div>
        <div className="live-metric">
          <span>Hz (modelled)</span>
          <b className="mono">{hz.toFixed(3)}</b>
          <span className="muted">not a PMU</span>
        </div>
        <div className="live-wx">
          {wx.length
            ? wx.map((c) => (
                <div key={c.city}>
                  <span>{c.city}</span>
                  <b className="mono">{c.tempC == null ? "—" : `${c.tempC.toFixed(1)}°`}</b>
                </div>
              ))
            : <span className="muted">{wxNote}</span>}
        </div>
      </div>
      <p className="unread" style={{ marginTop: -8 }}>
        {wxNote}. Demand = typical Indian diurnal load + heat above 28°C.
      </p>

      <div className="demand-row">
        <svg viewBox="0 0 240 36" className="demand-svg" aria-label="typical daily demand">
          <polyline
            fill="none"
            stroke="rgba(226,163,54,0.85)"
            strokeWidth="2"
            points={shape.map((y, h) => `${h * 10},${34 - y * 30}`).join(" ")}
          />
          <circle cx={ist.getHours() * 10 + (ist.getMinutes() / 60) * 10} cy={34 - demand * 30} r="3" fill="#e2a336" />
        </svg>
        <span className="muted">today’s shape · now</span>
      </div>

      <form
        className="cmd-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void runCommand(cmd);
        }}
      >
        <span className="mono cmd-prompt">l2›</span>
        <input
          ref={cmdRef}
          value={cmd}
          disabled={busy}
          placeholder="peak · discom · opt-out pune · release · allocate 12 · help"
          onChange={(e) => setCmd(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="btn primary" disabled={busy}>
          Run
        </button>
      </form>
      <div className="cmd-hints">
        {HINTS.map((h) => (
          <button key={h} className="demo-chip" type="button" disabled={busy} onClick={() => void runCommand(h)}>
            {h}
          </button>
        ))}
      </div>

      <div className="demo-bar">
        <div className="demo-clock mono">{step?.t ?? clock.slice(0, 5)}</div>
        <div className="demo-progress">
          <div
            className="demo-progress-fill"
            style={{ width: `${idx < 0 ? 0 : ((idx + 1) / STUDY.length) * 100}%` }}
          />
        </div>
        <span className="muted">{idx < 0 ? "ready" : `${idx + 1} / ${STUDY.length}`}</span>
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
            <button key={n} className={`btn ${speed === n ? "primary" : ""}`} onClick={() => setSpeed(n)}>
              {n}×
            </button>
          ))}
        </div>
      </div>

      <div className="demo-grid">
        <div className="panel">
          <h2>Fleet</h2>
          <div className="demo-devices">
            {data.devices.map((d) => (
              <FleetCard
                key={d.device_id}
                d={d}
                hit={hit.includes(d.device_id)}
                alloc={latestByDevice.get(d.device_id)}
                capKwh={caps[d.device_id]?.energy_capacity_kwh}
                exportKw={sites[d.site_id]?.export_limit_kw ?? null}
                tempC={wx.find((c) => c.territory === sites[d.site_id]?.utility_territory)?.tempC ?? null}
              />
            ))}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h2>{step ? step.title : "Desk"}</h2>
            <p className="orch-copy">
              {step
                ? step.body
                : `Live demand is ${demand.toFixed(2)}. Type peak to fire at that index, or Play study to walk a scripted day.`}
            </p>
            {step ? (
              <p>
                <span className="pill amber">expect</span> {step.expect}
              </p>
            ) : null}
            {lastRun ? (
              <div className="split">
                <div>
                  <span className="muted">last solve</span>
                  <div className="mono">
                    {lastRun.allocated_kw.toFixed(1)} / {lastRun.target_kw} kW
                    {lastRun.shortfall_kw > 0.05 ? ` · short ${lastRun.shortfall_kw.toFixed(1)}` : ""}
                  </div>
                </div>
                <div>
                  <span className="muted">λ</span>
                  <div className="mono">{lastRun.lambda.toFixed(2)}</div>
                </div>
                <div>
                  <span className="muted">held</span>
                  <div className="mono">{liveRsv}</div>
                </div>
              </div>
            ) : null}
            {lastRun ? <AllocBars data={data} runId={lastRun.run_id} /> : null}
            {last ? (
              <div className="demo-outcome">
                <div className="mono">
                  {last.signal.source} = {last.signal.value}
                </div>
                {last.trace.map((t) => (
                  <div key={t.rule_id}>
                    <span className="mono">{t.rule_id}</span>{" "}
                    {t.skipped_duplicate ? (
                      <span className="pill">duplicate skip</span>
                    ) : t.crossed ? (
                      <span className="pill amber">fired · {t.device_ids.length}</span>
                    ) : (
                      <span className="pill">no cross</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="panel">
            <h2>Tape</h2>
            <ol className="demo-tape">
              {log.map((line, i) => (
                <li key={`${line}-${i}`} className="mono">
                  {line}
                </li>
              ))}
              {data.messages.slice(0, 6).map((m) => (
                <li key={m.message_id} className="mono">
                  {m.message_type} · {DEVICE_LABEL[m.device_id]?.short ?? m.device_id} ·{" "}
                  <span className={messageClass(m.status)}>{m.status}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Study beats</h2>
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

function AllocBars({ data, runId }: { data: Snapshot; runId: string }) {
  const rows = data.allocations.filter((a) => a.run_id === runId);
  const max = Math.max(0.1, ...rows.map((a) => Math.abs(a.p_setpoint_kw)));
  if (!rows.length) return null;
  return (
    <div className="alloc-bars">
      {rows.map((a) => (
        <div className="alloc-bar" key={a.allocation_id}>
          <span>{DEVICE_LABEL[a.device_id]?.short ?? a.device_id}</span>
          <div className="bar-track">
            <div className="bar-fill amber" style={{ width: `${(Math.abs(a.p_setpoint_kw) / max) * 100}%` }} />
          </div>
          <b className="mono">{a.p_setpoint_kw.toFixed(1)}</b>
        </div>
      ))}
    </div>
  );
}

function FleetCard({
  d,
  hit,
  alloc,
  capKwh,
  exportKw,
  tempC,
}: {
  d: Device;
  hit: boolean;
  alloc?: DeviceAllocation;
  capKwh?: number;
  exportKw: number | null;
  tempC: number | null;
}) {
  const label = DEVICE_LABEL[d.device_id];
  const live = alloc && ["sent", "confirmed", "pending"].includes(alloc.status);
  const soc = d.last_soc_pct;
  return (
    <article
      className={`demo-device ${hit ? "hit" : ""} ${d.device_status !== "active" ? "off" : ""} ${live ? "live" : ""}`}
    >
      <header>
        <span className="dot" data-class={d.device_class} />
        <span>{label?.name ?? d.device_id}</span>
      </header>
      <div className="muted">
        {label?.city ?? d.site_id}
        {tempC != null ? ` · ${tempC.toFixed(0)}°C` : ""}
        {exportKw != null ? ` · export ${exportKw} kW` : ""}
      </div>
      {soc != null ? (
        <div className="soc">
          <div className="soc-fill" style={{ width: `${Math.max(0, Math.min(100, soc))}%` }} />
        </div>
      ) : (
        <div className="soc empty-soc" />
      )}
      <div className="demo-pills">
        <span className={d.device_status === "active" ? "pill green" : "pill"}>{d.device_status}</span>
        <span className={dispatchClass(d.current_dispatch_state)}>{d.current_dispatch_state}</span>
        <span className={configClass(d.config_status)}>{d.config_status}</span>
        {d.opt_out_until ? <span className="pill red">opt-out</span> : null}
        {live ? (
          <span className="pill amber">{alloc.p_setpoint_kw.toFixed(1)} kW</span>
        ) : soc != null ? (
          <span className="muted mono">{soc.toFixed(0)}%</span>
        ) : null}
      </div>
      {capKwh ? <span className="unread">{capKwh} kWh pack</span> : null}
    </article>
  );
}
