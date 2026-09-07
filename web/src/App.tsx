import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Dashboard } from "./Dashboard";
import { Demo } from "./Demo";
import { FlowchartPage } from "./Flowchart";
import { Orchestration } from "./Orchestration";
import { configClass, dispatchClass, messageClass } from "./status";
import type { Snapshot, SignalResult, Tab } from "./types";

const TABS: { id: Tab; label: string }[] = [
  { id: "demo", label: "Demo" },
  { id: "dash", label: "Dashboard" },
  { id: "flow", label: "Flowchart" },
  { id: "orch", label: "Orchestration" },
  { id: "reach", label: "Reachability" },
  { id: "inventory", label: "Inventory" },
  { id: "lists", label: "Lists" },
  { id: "rules", label: "Rules" },
  { id: "signals", label: "Signals" },
  { id: "messages", label: "Messages" },
  { id: "alloc", label: "Allocations" },
  { id: "log", label: "Dispatch log" },
];

const empty: Snapshot = {
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

export default function App() {
  const [tab, setTab] = useState<Tab>("demo");
  const [data, setData] = useState<Snapshot>(empty);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignalResult | null>(null);

  const load = useCallback(async () => {
    try {
      setError("");
      setData(await api.snapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void api.tick().then(() => load());
    }, 400);
    return () => window.clearInterval(id);
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <strong>L2</strong>
          <span>Capability allocation</span>
        </div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <p className="rail-note">
          L2 asks: how much can each device give, and how should a fleet
          target be split? Equal-stress QP, site caps, reservations. Not
          forecasting — that is L3.
        </p>
      </aside>
      <main className="main">
        {error ? <p className="error">{error}</p> : null}
        {tab === "dash" && (
          <Dashboard
            data={data}
            result={result}
            onSeed={() => run(() => api.seed())}
            busy={busy}
            onNavigate={setTab}
          />
        )}
        {tab === "demo" && (
          <Demo
            data={data}
            onRefresh={load}
            onResult={setResult}
          />
        )}
        {tab === "flow" && <FlowchartPage data={data} result={result} />}
        {tab === "orch" && <Orchestration data={data} result={result} />}
        {tab === "reach" && <Reach data={data} onSeed={() => run(() => api.seed())} busy={busy} />}
        {tab === "inventory" && <Inventory data={data} run={run} busy={busy} />}
        {tab === "lists" && <Lists data={data} run={run} busy={busy} />}
        {tab === "rules" && <Rules data={data} run={run} busy={busy} />}
        {tab === "signals" && (
          <Signals
            data={data}
            busy={busy}
            result={result}
            onInject={async (source, value, signalId) => {
              setBusy(true);
              setError("");
              try {
                const next = await api.signal(source, value, signalId);
                setResult(next);
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {tab === "messages" && (
          <Messages data={data} run={run} busy={busy} />
        )}
        {tab === "alloc" && <Allocations data={data} run={run} busy={busy} />}
        {tab === "log" && <Log data={data} />}
      </main>
    </div>
  );
}

function Reach({
  data,
  onSeed,
  busy,
}: {
  data: Snapshot;
  onSeed: () => void;
  busy: boolean;
}) {
  const channels = useMemo(
    () => Object.fromEntries(data.channels.map((c) => [c.channel_id, c])),
    [data.channels],
  );
  const sites = useMemo(
    () => Object.fromEntries(data.sites.map((s) => [s.site_id, s])),
    [data.sites],
  );

  return (
    <>
      <p className="kicker">L2 · registry + slack</p>
      <h1>How much can each device give right now?</h1>
      <p className="lede">
        Reachability is still L0. Delivery is still L1. L2 reads telemetry,
        capability, and the failsafe floor, then splits a fleet target into
        per-device setpoints.
      </p>
      {data.devices.length === 0 ? (
        <div className="banner">
          <span>Empty store. Load the generic demo fleet to walk the loop.</span>
          <button className="btn primary" onClick={onSeed} disabled={busy}>
            Seed demo fleet
          </button>
        </div>
      ) : null}
      <div className="stats">
        <div className="stat">
          <b>{data.sites.length}</b>
          <span>Sites</span>
        </div>
        <div className="stat">
          <b>{data.devices.length}</b>
          <span>Devices</span>
        </div>
        <div className="stat">
          <b>{data.channels.length}</b>
          <span>Channels</span>
        </div>
        <div className="stat">
          <b>{data.lists.length}</b>
          <span>Broadcast lists</span>
        </div>
        <div className="stat">
          <b>{data.dispatch_log.length}</b>
          <span>Dispatch events</span>
        </div>
        <div className="stat">
          <b>{data.messages.length}</b>
          <span>Messages</span>
        </div>
      </div>
      <div className="panel">
        <h2>Reachability</h2>
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Class</th>
              <th>Site</th>
              <th>Territory</th>
              <th>Channel</th>
              <th>Endpoint</th>
              <th>kW</th>
              <th>device_status</th>
              <th>dispatch</th>
              <th>config</th>
              <th>Reserve %</th>
            </tr>
          </thead>
          <tbody>
            {data.devices.map((d) => {
              const ch = channels[d.channel_id];
              const site = sites[d.site_id];
              return (
                <tr key={d.device_id}>
                  <td className="mono">{d.device_id}</td>
                  <td>{d.device_class}</td>
                  <td className="mono">{d.site_id}</td>
                  <td>{site?.utility_territory ?? "—"}</td>
                  <td>
                    <span className="pill cyan">{ch?.channel_type ?? d.channel_id}</span>
                  </td>
                  <td className="mono">{ch?.endpoint ?? "—"}</td>
                  <td className="mono">{d.rated_capacity_kw}</td>
                  <td>
                    <span className={d.device_status === "active" ? "pill green" : "pill"}>
                      {d.device_status}
                    </span>
                  </td>
                  <td>
                    <span className={dispatchClass(d.current_dispatch_state)}>
                      {d.current_dispatch_state}
                    </span>
                  </td>
                  <td>
                    <span className={configClass(d.config_status)}>{d.config_status}</span>
                  </td>
                  <td>
                    <span className="mono" title="Failsafe payload L1 pushes and confirms.">
                      {d.reserve_bound_pct}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Inventory({
  data,
  run,
  busy,
}: {
  data: Snapshot;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  return (
    <>
      <p className="kicker">Entities</p>
      <h1>Inventory</h1>
      <p className="lede">
        SITE hosts DEVICE. CHANNEL reaches DEVICE. New devices start{" "}
        <code>config_status=unsynced</code> and{" "}
        <code>current_dispatch_state=idle</code>. Changing{" "}
        <code>reserve_bound_pct</code> marks the failsafe stale — push it from
        here.
      </p>
      <div className="row">
        <div className="panel">
          <h2>Sites</h2>
          <form
            className="grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(() =>
                api.createSite({
                  site_id: String(f.get("site_id") || "") || undefined,
                  customer_id: String(f.get("customer_id")),
                  utility_territory: String(f.get("utility_territory")),
                }),
              );
              e.currentTarget.reset();
            }}
          >
            <label>
              site_id
              <input name="site_id" placeholder="auto" />
            </label>
            <label>
              customer_id
              <input name="customer_id" required />
            </label>
            <label>
              utility_territory
              <input name="utility_territory" required placeholder="BESCOM" />
            </label>
            <label>
              &nbsp;
              <button className="btn primary" disabled={busy}>
                Add site
              </button>
            </label>
          </form>
          <table>
            <thead>
              <tr>
                <th>site_id</th>
                <th>customer</th>
                <th>territory</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((s) => (
                <tr key={s.site_id}>
                  <td className="mono">{s.site_id}</td>
                  <td>{s.customer_id}</td>
                  <td>{s.utility_territory}</td>
                  <td>
                    <button
                      className="btn danger"
                      onClick={() => run(() => api.deleteSite(s.site_id))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h2>Channels</h2>
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(() =>
              api.createChannel({
                channel_id: String(f.get("channel_id") || "") || undefined,
                channel_type: String(f.get("channel_type")),
                endpoint: String(f.get("endpoint")),
              }),
            );
            e.currentTarget.reset();
          }}
        >
          <label>
            channel_id
            <input name="channel_id" placeholder="auto" />
          </label>
          <label>
            type
            <select name="channel_type" defaultValue="sms">
              <option>sms</option>
              <option>phone</option>
              <option>relay</option>
              <option>api</option>
            </select>
          </label>
          <label>
            endpoint
            <input name="endpoint" required placeholder="+91… / gw://… / https://…" />
          </label>
          <label>
            &nbsp;
            <button className="btn primary" disabled={busy}>
              Add channel
            </button>
          </label>
        </form>
        <table>
          <thead>
            <tr>
              <th>channel_id</th>
              <th>type</th>
              <th>endpoint</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.channels.map((c) => (
              <tr key={c.channel_id}>
                <td className="mono">{c.channel_id}</td>
                <td>
                  <span className="pill cyan">{c.channel_type}</span>
                </td>
                <td className="mono">{c.endpoint}</td>
                <td>
                  <button
                    className="btn danger"
                    onClick={() => run(() => api.deleteChannel(c.channel_id))}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Devices</h2>
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(() =>
              api.createDevice({
                device_id: String(f.get("device_id") || "") || undefined,
                site_id: String(f.get("site_id")),
                channel_id: String(f.get("channel_id")),
                device_class: String(f.get("device_class")),
                rated_capacity_kw: Number(f.get("rated_capacity_kw")),
                reserve_bound_pct: Number(f.get("reserve_bound_pct")),
                device_status: String(f.get("device_status")),
              }),
            );
            e.currentTarget.reset();
          }}
        >
          <label>
            device_id
            <input name="device_id" placeholder="auto" />
          </label>
          <label>
            site
            <select name="site_id" required>
              {data.sites.map((s) => (
                <option key={s.site_id}>{s.site_id}</option>
              ))}
            </select>
          </label>
          <label>
            channel
            <select name="channel_id" required>
              {data.channels.map((c) => (
                <option key={c.channel_id}>{c.channel_id}</option>
              ))}
            </select>
          </label>
          <label>
            class
            <input name="device_class" required placeholder="battery" />
          </label>
          <label>
            rated_capacity_kw
            <input name="rated_capacity_kw" type="number" step="0.1" required />
          </label>
          <label>
            reserve_bound_pct
            <input name="reserve_bound_pct" type="number" step="0.1" defaultValue={20} />
          </label>
          <label>
            device_status
            <select name="device_status" defaultValue="active">
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="decommissioned">decommissioned</option>
            </select>
          </label>
          <label>
            &nbsp;
            <button className="btn primary" disabled={busy}>
              Add device
            </button>
          </label>
        </form>
        <table>
          <thead>
            <tr>
              <th>device_id</th>
              <th>class</th>
              <th>site</th>
              <th>channel</th>
              <th>kW</th>
              <th>device_status</th>
              <th>dispatch</th>
              <th>config</th>
              <th>reserve %</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.devices.map((d) => (
              <tr key={d.device_id}>
                <td className="mono">{d.device_id}</td>
                <td>{d.device_class}</td>
                <td className="mono">{d.site_id}</td>
                <td className="mono">{d.channel_id}</td>
                <td className="mono">{d.rated_capacity_kw}</td>
                <td>
                  <select
                    value={d.device_status}
                    disabled={busy}
                    onChange={(e) =>
                      run(() =>
                        api.createDevice({
                          ...d,
                          device_status: e.target.value,
                        }),
                      )
                    }
                  >
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="decommissioned">decommissioned</option>
                  </select>
                </td>
                <td>
                  <span className={dispatchClass(d.current_dispatch_state)}>
                    {d.current_dispatch_state}
                  </span>
                </td>
                <td>
                  <span className={configClass(d.config_status)}>{d.config_status}</span>
                </td>
                <td>
                  <input
                    key={`${d.device_id}-${d.reserve_bound_pct}`}
                    type="number"
                    step="0.1"
                    defaultValue={d.reserve_bound_pct}
                    disabled={busy}
                    style={{ width: 72 }}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v !== d.reserve_bound_pct) {
                        void run(async () => {
                          await api.createDevice({
                            ...d,
                            reserve_bound_pct: v,
                          });
                          await api.configSync(d.device_id);
                        });
                      }
                    }}
                  />
                </td>
                <td>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => run(() => api.configSync(d.device_id))}
                  >
                    Sync
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => run(() => api.deleteDevice(d.device_id))}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Lists({
  data,
  run,
  busy,
}: {
  data: Snapshot;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  return (
    <>
      <p className="kicker">Fan-out</p>
      <h1>Broadcast lists</h1>
      <p className="lede">
        A rule still targets a list. Every reachable member gets the same
        instruction as its own CHANNEL_MESSAGE. L1 does not pick a subset for
        capability — it only skips <code>paused</code> /{" "}
        <code>decommissioned</code> and devices already{" "}
        <code>dispatched</code>.
      </p>
      <div className="panel">
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(() =>
              api.createList({
                list_id: String(f.get("list_id") || "") || undefined,
                name: String(f.get("name")),
              }),
            );
            e.currentTarget.reset();
          }}
        >
          <label>
            list_id
            <input name="list_id" placeholder="auto" />
          </label>
          <label>
            name
            <input name="name" required placeholder="Peak-shave batteries" />
          </label>
          <label>
            &nbsp;
            <button className="btn primary" disabled={busy}>
              Add list
            </button>
          </label>
        </form>
      </div>
      {data.lists.map((lst) => (
        <div className="panel" key={lst.list_id}>
          <h2>
            {lst.name} <span className="mono">({lst.list_id})</span>
          </h2>
          <div className="members">
            {data.devices.map((d) => {
              const on = lst.device_ids.includes(d.device_id);
              return (
                <label className="check" key={d.device_id}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={() =>
                      run(() =>
                        on
                          ? api.removeMember(lst.list_id, d.device_id)
                          : api.addMember(lst.list_id, d.device_id),
                      )
                    }
                  />
                  {d.device_id}{" "}
                  <span className={d.device_status === "active" ? "pill green" : "pill"}>
                    {d.device_status}
                  </span>{" "}
                  <span className={dispatchClass(d.current_dispatch_state)}>
                    {d.current_dispatch_state}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn danger" onClick={() => run(() => api.deleteList(lst.list_id))}>
              Delete list
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function Rules({
  data,
  run,
  busy,
}: {
  data: Snapshot;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  return (
    <>
      <p className="kicker">Threshold</p>
      <h1>Rules</h1>
      <p className="lede">
        If the named signal crosses the comparator, each <code>active</code>{" "}
        list member that is not already <code>dispatched</code> gets a pending{" "}
        <code>CHANNEL_MESSAGE</code> with <code>fixed_instruction</code>.
        Inactive rules are skipped. Lower <code>priority</code> runs first.
      </p>
      <div className="panel">
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(() =>
              api.createRule({
                rule_id: String(f.get("rule_id") || "") || undefined,
                signal_source: String(f.get("signal_source")),
                comparator: String(f.get("comparator")),
                threshold_value: Number(f.get("threshold_value")),
                list_id: String(f.get("list_id")),
                fixed_instruction: String(f.get("fixed_instruction")),
                priority: Number(f.get("priority") || 100),
                is_active: f.get("is_active") === "on",
              }),
            );
            e.currentTarget.reset();
          }}
        >
          <label>
            rule_id
            <input name="rule_id" placeholder="auto" />
          </label>
          <label>
            signal_source
            <input name="signal_source" required placeholder="forecast_peak" />
          </label>
          <label>
            comparator
            <select name="comparator" defaultValue=">">
              {[">", ">=", "<", "<=", "==", "!="].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            threshold
            <input name="threshold_value" type="number" step="0.01" required />
          </label>
          <label>
            list
            <select name="list_id" required>
              {data.lists.map((l) => (
                <option key={l.list_id} value={l.list_id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            fixed_instruction
            <input name="fixed_instruction" required placeholder="DISCHARGE 0.5 PU" />
          </label>
          <label>
            priority
            <input name="priority" type="number" defaultValue={100} />
          </label>
          <label className="check">
            <input name="is_active" type="checkbox" defaultChecked />
            active
          </label>
          <label>
            &nbsp;
            <button className="btn primary" disabled={busy}>
              Add rule
            </button>
          </label>
        </form>
        <table>
          <thead>
            <tr>
              <th>rule</th>
              <th>pri</th>
              <th>when</th>
              <th>list</th>
              <th>instruction</th>
              <th>active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.rule_id}>
                <td className="mono">{r.rule_id}</td>
                <td className="mono">{r.priority}</td>
                <td className="mono">
                  {r.signal_source} {r.comparator} {r.threshold_value}
                </td>
                <td className="mono">{r.list_id}</td>
                <td>
                  <span className="pill amber">{r.fixed_instruction}</span>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.is_active}
                    disabled={busy}
                    onChange={() =>
                      run(() =>
                        api.createRule({
                          ...r,
                          is_active: !r.is_active,
                        }),
                      )
                    }
                  />
                </td>
                <td>
                  <button className="btn danger" onClick={() => run(() => api.deleteRule(r.rule_id))}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Signals({
  data,
  busy,
  result,
  onInject,
}: {
  data: Snapshot;
  busy: boolean;
  result: SignalResult | null;
  onInject: (source: string, value: number, signalId?: string) => void;
}) {
  const [source, setSource] = useState("forecast_peak");
  const [value, setValue] = useState("0.9");
  const [signalId, setSignalId] = useState("");
  return (
    <>
      <p className="kicker">Loop</p>
      <h1>Inject a signal</h1>
      <p className="lede">
        Duplicate <code>(rule_id, signal_id)</code> is skipped. Devices that
        are not <code>active</code>, or already <code>dispatched</code>, are
        not sent. DISPATCH_LOG is written before send. Each send is a pending
        CHANNEL_MESSAGE with ack / nack / timeout.
      </p>
      <div className="actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => onInject("forecast_peak", 0.9)}
        >
          forecast_peak = 0.9
        </button>
        <button className="btn" disabled={busy} onClick={() => onInject("forecast_peak", 0.85)}>
          forecast_peak = 0.85 (miss)
        </button>
        <button className="btn" disabled={busy} onClick={() => onInject("discom_call", 1)}>
          discom_call = 1
        </button>
      </div>
      <form
        className="grid"
        onSubmit={(e) => {
          e.preventDefault();
          onInject(source, Number(value), signalId || undefined);
        }}
      >
        <label>
          source
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
        <label>
          value
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label>
          signal_id
          <input
            value={signalId}
            onChange={(e) => setSignalId(e.target.value)}
            placeholder="auto if empty"
          />
        </label>
        <label>
          &nbsp;
          <button className="btn primary" disabled={busy}>
            Evaluate
          </button>
        </label>
      </form>
      <div className="row">
        <div className="panel">
          <h2>Pseudocode</h2>
          <pre className="loop">{loopText(result)}</pre>
        </div>
        <div className="panel">
          <h2>This pass</h2>
          {result ? (
            <>
              <p>
                Signal <code>{result.signal.source}</code> = {result.signal.value}{" "}
                <span className="mono">({result.signal.signal_id})</span>
                {result.skipped_duplicate ? (
                  <span className="pill">duplicate · skipped</span>
                ) : null}
                . Matching rules: {result.matching_rule_ids.join(", ") || "none"}. Fired
                events: {result.fired_event_ids.length}.
              </p>
              {result.trace.map((t) => (
                <div className="trace-card" key={t.rule_id}>
                  <strong className="mono">{t.rule_id}</strong>{" "}
                  <span className={t.crossed ? "pill amber" : "pill"}>
                    {t.crossed ? "fired" : "not crossed"}
                  </span>
                  <div>
                    {t.fixed_instruction} → {t.device_ids.length} CHANNEL_MESSAGE
                    {t.device_ids.length === 1 ? "" : "s"}
                  </div>
                  <div className="mono" style={{ color: "var(--muted)", marginTop: 6 }}>
                    {t.device_ids.join(", ") || "empty list"}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <p style={{ color: "var(--muted)" }}>Inject a signal to trace the loop.</p>
          )}
        </div>
      </div>
      <p className="unread">
        {data.rules.length} rules in store. {data.messages.length} CHANNEL_MESSAGE
        rows. Reserve bounds are pushed on the config-sync loop, not this one.
      </p>
    </>
  );
}

function loopText(result: SignalResult | null): string {
  if (!result) {
    return `for signal in incoming_signals:
    matching_rules = active ThresholdRule.where(source).order_by(priority)
    for rule in matching_rules:
        if compare(signal.value, rule.comparator, rule.threshold_value):
            if DispatchLog.exists(rule_id, signal_id): continue
            event = DispatchLog.create(..., signal_id)   # before send
            for device in list.devices:
                if device.device_status != 'active': continue
                if device.current_dispatch_state == 'dispatched': continue
                CHANNEL_MESSAGE pending
                Channel.send(..., on_ack=handle_ack)`;
  }
  if (result.skipped_duplicate && result.fired_event_ids.length === 0) {
    return `(rule_id, signal_id=${result.signal.signal_id}) already logged — no new CHANNEL_MESSAGE`;
  }
  const fired = result.trace.filter((t) => t.crossed);
  const sends = fired.reduce((n, t) => n + t.device_ids.length, 0);
  const pending = result.messages.filter((m) => m.status === "pending").length;
  const acked = result.messages.filter((m) => m.status === "acked").length;
  return `signal = ${result.signal.source} ${result.signal.value} id=${result.signal.signal_id}
matching_rules = [${result.matching_rule_ids.join(", ") || ""}]
${result.trace
  .map(
    (t) =>
      `compare(${result.signal.value}, ${t.comparator}, ${t.threshold_value}) -> ${t.crossed}
${t.crossed ? `DispatchLog.create(${t.rule_id})
CHANNEL_MESSAGE × ${t.device_ids.length}  "${t.fixed_instruction}"
Channel.send(..., on_ack)` : "skip"}`,
  )
  .join("\n")}
# ${sends} CHANNEL_MESSAGE rows this pass, ${result.fired_event_ids.length} audit rows
# tape now: ${pending} pending, ${acked} acked`;
}

function Allocations({
  data,
  run,
  busy,
}: {
  data: Snapshot;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const latest = data.dispatch_log[0];
  return (
    <>
      <p className="kicker">L2 · solver</p>
      <h1>Allocations</h1>
      <p className="lede">
        One SOLVER_RUN per fire (and each re-allocation). DEVICE_ALLOCATION is
        the quantized setpoint actually sent. HEADROOM_RESERVATION is held
        before the message goes out so overlapping events cannot double-count
        the same kWh.
      </p>
      <div className="stats">
        <div className="stat">
          <b>{data.solver_runs.length}</b>
          <span>Solver runs</span>
        </div>
        <div className="stat">
          <b>{data.allocations.length}</b>
          <span>Allocations</span>
        </div>
        <div className="stat">
          <b>{data.reservations.filter((r) => r.status !== "released").length}</b>
          <span>Live reservations</span>
        </div>
      </div>
      {latest ? (
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => run(() => api.release(latest.event_id))}>
            Release latest event
          </button>
        </div>
      ) : null}
      <div className="panel">
        <h2>SOLVER_RUN</h2>
        <table>
          <thead>
            <tr>
              <th>run</th>
              <th>#</th>
              <th>target kW</th>
              <th>allocated</th>
              <th>shortfall</th>
              <th>λ</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {data.solver_runs.map((r) => (
              <tr key={r.run_id}>
                <td className="mono">{r.run_id}</td>
                <td className="mono">{r.run_number}</td>
                <td className="mono">{r.target_kw}</td>
                <td className="mono">{r.allocated_kw.toFixed(2)}</td>
                <td className="mono">{r.shortfall_kw.toFixed(2)}</td>
                <td className="mono">{r.lambda.toFixed(3)}</td>
                <td>
                  <span className={r.status === "optimal" ? "pill green" : "pill amber"}>{r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>DEVICE_ALLOCATION</h2>
        <table>
          <thead>
            <tr>
              <th>device</th>
              <th>p_setpoint</th>
              <th>raw</th>
              <th>headroom</th>
              <th>floor SoC</th>
              <th>binding</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {data.allocations.map((a) => (
              <tr key={a.allocation_id}>
                <td className="mono">{a.device_id}</td>
                <td className="mono">{a.p_setpoint_kw.toFixed(2)} kW</td>
                <td className="mono">{a.p_setpoint_raw_kw.toFixed(2)}</td>
                <td className="mono">{a.headroom_kw.toFixed(2)}</td>
                <td className="mono">{a.floor_soc_pct.toFixed(0)}%</td>
                <td>
                  <span className="pill cyan">{a.binding_constraint}</span>
                </td>
                <td>
                  <span className={a.status === "confirmed" ? "pill green" : "pill"}>{a.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Messages({
  data,
  run,
  busy,
}: {
  data: Snapshot;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const pending = data.messages.filter((m) => m.status === "pending").length;
  const acked = data.messages.filter((m) => m.status === "acked").length;
  const nacked = data.messages.filter((m) => m.status === "nacked").length;
  const timed = data.messages.filter((m) => m.status === "timed_out").length;
  const dispatchN = data.messages.filter((m) => m.message_type === "dispatch_instruction").length;
  const configN = data.messages.filter((m) => m.message_type === "config_sync").length;
  return (
    <>
      <p className="kicker">L1 · source of truth</p>
      <h1>CHANNEL_MESSAGE</h1>
      <p className="lede">
        One row per attempt. Retries are new chained rows via{" "}
        <code>retry_of_message_id</code>, not mutations.{" "}
        <code>handle_ack</code> and the timeout watcher only act while status
        is still <code>pending</code>. Config-sync rows have a null{" "}
        <code>event_id</code>.
      </p>
      <div className="stats">
        <div className="stat">
          <b>{dispatchN}</b>
          <span>dispatch_instruction</span>
        </div>
        <div className="stat">
          <b>{configN}</b>
          <span>config_sync</span>
        </div>
        <div className="stat">
          <b>{pending}</b>
          <span>pending</span>
        </div>
        <div className="stat">
          <b>{acked}</b>
          <span>acked</span>
        </div>
        <div className="stat">
          <b>{nacked}</b>
          <span>nacked</span>
        </div>
        <div className="stat">
          <b>{timed}</b>
          <span>timed_out</span>
        </div>
      </div>
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => run(() => api.configSync())}>
          Push failsafe (unsynced / stale / failed)
        </button>
      </div>
      <div className="panel">
        <h2>Tape</h2>
        <table>
          <thead>
            <tr>
              <th>message_id</th>
              <th>type</th>
              <th>device</th>
              <th>event</th>
              <th>status</th>
              <th>try</th>
              <th>retry of</th>
              <th>payload</th>
              <th>sent</th>
              <th>ack</th>
            </tr>
          </thead>
          <tbody>
            {data.messages.map((m) => (
              <tr key={m.message_id}>
                <td className="mono">{m.message_id}</td>
                <td>
                  <span className={m.message_type === "config_sync" ? "pill cyan" : "pill amber"}>
                    {m.message_type}
                  </span>
                </td>
                <td className="mono">{m.device_id}</td>
                <td className="mono">{m.event_id ?? "—"}</td>
                <td>
                  <span className={messageClass(m.status)}>{m.status}</span>
                </td>
                <td className="mono">{m.attempt_number}</td>
                <td className="mono">{m.retry_of_message_id ?? "—"}</td>
                <td>{m.payload}</td>
                <td className="mono">{m.sent_at}</td>
                <td className="mono">{m.ack_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.messages.length === 0 ? (
          <p className="empty">No messages yet. Inject a signal or push failsafe.</p>
        ) : null}
      </div>
    </>
  );
}

function Log({ data }: { data: Snapshot }) {
  return (
    <>
      <p className="kicker">Audit</p>
      <h1>Dispatch log</h1>
      <p className="lede">
        One row per rule fire, written before Channel.send. Instruction text
        only — per-device outcome lives on CHANNEL_MESSAGE. The journal below
        is still the transport log, not delivery confirmation.
      </p>
      <div className="panel">
        <h2>DISPATCH_LOG</h2>
        <table>
          <thead>
            <tr>
              <th>event_id</th>
              <th>signal_id</th>
              <th>rule_id</th>
              <th>triggered_at</th>
              <th>instruction_text</th>
            </tr>
          </thead>
          <tbody>
            {data.dispatch_log.map((e) => (
              <tr key={e.event_id}>
                <td className="mono">{e.event_id}</td>
                <td className="mono">{e.signal_id}</td>
                <td className="mono">{e.rule_id}</td>
                <td className="mono">{e.triggered_at}</td>
                <td>
                  <span className="pill amber">{e.instruction_text}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>Channel.send journal (transport, not ack)</h2>
        <table>
          <thead>
            <tr>
              <th>when</th>
              <th>type</th>
              <th>endpoint</th>
              <th>instruction</th>
            </tr>
          </thead>
          <tbody>
            {data.sends.map((s) => (
              <tr key={s.send_id}>
                <td className="mono">{s.attempted_at}</td>
                <td>
                  <span className="pill cyan">{s.channel_type}</span>
                </td>
                <td className="mono">{s.endpoint}</td>
                <td>{s.instruction_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
