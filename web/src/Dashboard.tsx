import { useMemo } from "react";
import { CompactFlow } from "./Flowchart";
import { configClass, dispatchClass } from "./status";
import type { SignalResult, Snapshot, Tab } from "./types";

export function Dashboard({
  data,
  result,
  onSeed,
  busy,
  onNavigate,
}: {
  data: Snapshot;
  result: SignalResult | null;
  onSeed: () => void;
  busy: boolean;
  onNavigate: (tab: Tab) => void;
}) {
  const channels = useMemo(
    () => Object.fromEntries(data.channels.map((c) => [c.channel_id, c])),
    [data.channels],
  );
  const sites = useMemo(
    () => Object.fromEntries(data.sites.map((s) => [s.site_id, s])),
    [data.sites],
  );
  const listed = useMemo(() => {
    const set = new Set<string>();
    for (const lst of data.lists) for (const id of lst.device_ids) set.add(id);
    return set;
  }, [data.lists]);

  const nameplateKw = data.devices.reduce((n, d) => n + d.rated_capacity_kw, 0);
  const unlistened = data.devices.filter((d) => !listed.has(d.device_id));
  const notReachable = data.devices.filter((d) => d.device_status !== "active");
  const unusedChannels = data.channels.filter(
    (c) => !data.devices.some((d) => d.channel_id === c.channel_id),
  );
  const emptySites = data.sites.filter((s) => !data.devices.some((d) => d.site_id === s.site_id));
  const emptyLists = data.lists.filter((l) => l.device_ids.length === 0);

  const byTerritory = countBy(data.devices, (d) => sites[d.site_id]?.utility_territory ?? "—");
  const byClass = countBy(data.devices, (d) => d.device_class);
  const byChannel = countBy(data.devices, (d) => channels[d.channel_id]?.channel_type ?? "—");
  const kwByTerritory = sumBy(
    data.devices,
    (d) => sites[d.site_id]?.utility_territory ?? "—",
    (d) => d.rated_capacity_kw,
  );
  const sendsByType = countBy(data.sends, (s) => s.channel_type);
  const msgByStatus = countBy(data.messages, (m) => m.status);
  const last = data.dispatch_log[0];
  const territories = [...new Set(data.sites.map((s) => s.utility_territory))].sort();
  const pending = data.messages.filter((m) => m.status === "pending").length;
  const failedDispatch = data.devices.filter((d) => d.current_dispatch_state === "failed").length;
  const configGap = data.devices.filter((d) => d.config_status !== "synced").length;

  return (
    <>
      <p className="kicker">L2 · visibility</p>
      <h1>Dashboard</h1>
      <p className="lede">
        Slack and split, not just delivery. Nameplate kW is registered;
        allocated kW is what the solver sent. Failsafe and contract floors
        bind before anything goes on the wire.
      </p>
      <div className="banner">
        <span>Watch a full peak-day study: misses, a fire, a duplicate skip, a paused device, then overlapping rules.</span>
        <button className="btn primary" onClick={() => onNavigate("demo")}>
          Open Demo
        </button>
      </div>

      {data.devices.length === 0 ? (
        <div className="banner">
          <span>Empty store. Load the demo fleet to populate the board.</span>
          <button className="btn primary" onClick={onSeed} disabled={busy}>
            Seed demo fleet
          </button>
        </div>
      ) : null}

      <div className="stats dash-stats">
        <button className="stat" onClick={() => onNavigate("inventory")}>
          <b>{data.sites.length}</b>
          <span>Sites</span>
        </button>
        <button className="stat" onClick={() => onNavigate("reach")}>
          <b>{data.devices.length}</b>
          <span>Devices</span>
        </button>
        <div className="stat">
          <b>{fmtKw(nameplateKw)}</b>
          <span>Nameplate kW</span>
        </div>
        <button className="stat" onClick={() => onNavigate("inventory")}>
          <b>{data.channels.length}</b>
          <span>Channels</span>
        </button>
        <button className="stat" onClick={() => onNavigate("rules")}>
          <b>{data.rules.length}</b>
          <span>Armed rules</span>
        </button>
        <button className="stat" onClick={() => onNavigate("log")}>
          <b>{data.dispatch_log.length}</b>
          <span>Dispatch events</span>
        </button>
        <button className="stat" onClick={() => onNavigate("messages")}>
          <b>{data.messages.length}</b>
          <span>CHANNEL_MESSAGE</span>
        </button>
        <button className="stat" onClick={() => onNavigate("messages")}>
          <b>{pending}</b>
          <span>Pending acks</span>
        </button>
        <button className="stat" onClick={() => onNavigate("alloc")}>
          <b>
            {data.solver_runs[0]
              ? data.solver_runs[0].allocated_kw.toFixed(1)
              : "0"}
          </b>
          <span>Last allocated kW</span>
        </button>
        <button className="stat" onClick={() => onNavigate("alloc")}>
          <b>{data.reservations.filter((r) => r.status !== "released").length}</b>
          <span>Live reservations</span>
        </button>
      </div>

      <CompactFlow data={data} result={result} />

      <div className="pipeline">
        <Pipe n={data.rules.length} label="rules watch a source" />
        <span className="pipe-arrow">→</span>
        <Pipe n={data.lists.length} label="static lists" />
        <span className="pipe-arrow">→</span>
        <Pipe n={listed.size} label="list members" />
        <span className="pipe-arrow">→</span>
        <Pipe n={data.allocations.length} label="setpoints" tone="cyan" />
        <span className="pipe-arrow">→</span>
        <Pipe
          n={data.solver_runs.reduce((n, r) => n + r.shortfall_kw, 0) > 0 ? 1 : 0}
          label="shortfall"
          tone="amber"
        />
      </div>

      <div className="dash-grid">
        <div className="panel">
          <h2>Fleet by territory</h2>
          {territories.length === 0 ? (
            <p className="empty">No sites yet.</p>
          ) : (
            <div className="territory-grid">
              {territories.map((t) => {
                const here = data.sites.filter((s) => s.utility_territory === t);
                return (
                  <div key={t} className="territory">
                    <header>
                      <strong>{t}</strong>
                      <span className="mono">
                        {here.length} sites · {fmtKw(kwByTerritory.find((x) => x.label === t)?.value ?? 0)} kW
                      </span>
                    </header>
                    {here.map((s) => {
                      const devices = data.devices.filter((d) => d.site_id === s.site_id);
                      return (
                        <article key={s.site_id} className="site-card">
                          <div className="site-card-top">
                            <span className="mono">{s.site_id}</span>
                            <span className="muted">{s.customer_id}</span>
                          </div>
                          {devices.length === 0 ? (
                            <p className="empty">No devices</p>
                          ) : (
                            <ul>
                              {devices.map((d) => {
                                const ch = channels[d.channel_id];
                                return (
                                  <li key={d.device_id}>
                                    <span className="dot" data-class={d.device_class} />
                                    <span className="mono">{d.device_id}</span>
                                    <span className="pill cyan">{ch?.channel_type ?? "—"}</span>
                                    <span
                                      className={
                                        d.device_status === "active" ? "pill green" : "pill"
                                      }
                                    >
                                      {d.device_status}
                                    </span>
                                    <span className={dispatchClass(d.current_dispatch_state)}>
                                      {d.current_dispatch_state}
                                    </span>
                                    <span className={configClass(d.config_status)}>{d.config_status}</span>
                                    {listed.has(d.device_id) ? (
                                      <span className="pill green">listed</span>
                                    ) : (
                                      <span className="pill">unlisted</span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </article>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="stack">
          <div className="panel">
            <h2>How we reach them</h2>
            <Bars items={byChannel} unit="devices" />
            <Bars items={byClass} unit="class" />
            <Bars items={byTerritory} unit="territory" />
          </div>
          <div className="panel">
            <h2>Broadcast coverage</h2>
            {data.lists.length === 0 ? (
              <p className="empty">No lists.</p>
            ) : (
              data.lists.map((lst) => (
                <div className="cover" key={lst.list_id}>
                  <div className="cover-top">
                    <button className="linkish" onClick={() => onNavigate("lists")}>
                      {lst.name}
                    </button>
                    <span className="mono">
                      {lst.device_ids.length}/{data.devices.length}
                    </span>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill amber"
                      style={{
                        width: `${data.devices.length ? (lst.device_ids.length / data.devices.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            )}
            <p className="unread" style={{ marginTop: 12 }}>
              {unlistened.length} device{unlistened.length === 1 ? "" : "s"} on no list — a
              rule cannot reach them.
            </p>
          </div>
        </div>
      </div>

      <div className="row">
        <div className="panel">
          <h2>Armed rules</h2>
          {data.rules.length === 0 ? (
            <p className="empty">No threshold rules.</p>
          ) : (
            <div className="rules-board">
              {data.rules.map((r) => {
                const lst = data.lists.find((l) => l.list_id === r.list_id);
                const n = lst?.device_ids.length ?? 0;
                return (
                  <button
                    key={r.rule_id}
                    className="rule-tile"
                    onClick={() => onNavigate("signals")}
                  >
                    <span className="mono faint">{r.rule_id}</span>
                    <strong className="mono">
                      {r.signal_source} {r.comparator} {r.threshold_value}
                    </strong>
                    <span>
                      pri {r.priority}
                      {r.is_active ? "" : " · inactive"} → {lst?.name ?? r.list_id}{" "}
                      <span className="muted">({n} devices)</span>
                    </span>
                    <span className="pill amber">{r.fixed_instruction}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="actions" style={{ marginTop: 12, marginBottom: 0 }}>
            <button className="btn" onClick={() => onNavigate("signals")}>
              Inject a signal
            </button>
          </div>
        </div>
        <div className="panel">
          <h2>Recent activity</h2>
          {last ? (
            <p className="last-fire">
              Last fire <span className="mono">{ago(last.triggered_at)}</span>
              {" · "}
              <span className="pill amber">{last.instruction_text}</span>
            </p>
          ) : (
            <p className="empty">No dispatch events yet.</p>
          )}
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>rule</th>
                <th>instruction</th>
              </tr>
            </thead>
            <tbody>
              {data.dispatch_log.slice(0, 8).map((e) => (
                <tr key={e.event_id}>
                  <td className="mono">{ago(e.triggered_at)}</td>
                  <td className="mono">{e.rule_id}</td>
                  <td>
                    <span className="pill amber">{e.instruction_text}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {msgByStatus.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <h2>CHANNEL_MESSAGE by status</h2>
              <Bars items={msgByStatus} unit="messages" />
              <p className="unread">
                Source of truth for delivery. Transport journal still has{" "}
                {sendsByType.reduce((n, x) => n + x.value, 0)} Channel.send calls.
              </p>
            </div>
          ) : sendsByType.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <h2>Channel.send this process</h2>
              <Bars items={sendsByType} unit="calls" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <h2>Gaps</h2>
        <div className="gaps">
          <Gap n={unlistened.length} label="devices on no broadcast list" />
          <Gap n={notReachable.length} label="paused or decommissioned" />
          <Gap n={pending} label="pending CHANNEL_MESSAGE" />
          <Gap n={failedDispatch} label="dispatch failed" />
          <Gap n={configGap} label="failsafe not synced" />
          <Gap n={data.rules.filter((r) => !r.is_active).length} label="inactive rules" />
          <Gap n={emptyLists.length} label="empty lists" />
          <Gap n={unusedChannels.length} label="channels reaching nobody" />
          <Gap n={emptySites.length} label="sites with no devices" />
        </div>
        {unlistened.length > 0 ? (
          <p className="mono muted" style={{ marginTop: 10 }}>
            {unlistened.map((d) => d.device_id).join(", ")}
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            Every registered device sits on at least one list.
          </p>
        )}
      </div>
    </>
  );
}

function Pipe({ n, label, tone }: { n: number; label: string; tone?: "amber" | "cyan" }) {
  return (
    <div className={`pipe ${tone ?? ""}`}>
      <b className="mono">{n}</b>
      <span>{label}</span>
    </div>
  );
}

function Gap({ n, label }: { n: number; label: string }) {
  return (
    <div className={`gap ${n ? "warn" : ""}`}>
      <b className="mono">{n}</b>
      <span>{label}</span>
    </div>
  );
}

function Bars({ items, unit }: { items: { label: string; value: number }[]; unit: string }) {
  if (items.length === 0) return <p className="empty">None.</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={`${unit}-${i.label}`}>
          <span>{i.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
          <b className="mono">{Number.isInteger(i.value) ? i.value : i.value.toFixed(1)}</b>
        </div>
      ))}
    </div>
  );
}

function countBy<T>(rows: T[], key: (r: T) => string): { label: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));
}

function sumBy<T>(
  rows: T[],
  key: (r: T) => string,
  val: (r: T) => number,
): { label: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
  return [...m.entries()].map(([label, value]) => ({ label, value }));
}

function fmtKw(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return iso.slice(0, 19).replace("T", " ");
}
