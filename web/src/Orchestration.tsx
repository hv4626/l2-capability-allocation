import { CompactFlow, LayerStack, RegistryFlow, RuntimeFlow } from "./Flowchart";
import type { SignalResult, Snapshot } from "./types";

export function Orchestration({
  data,
  result,
}: {
  data: Snapshot;
  result: SignalResult | null;
}) {
  const listed = new Set(data.lists.flatMap((l) => l.device_ids));
  const pending = data.messages.filter((m) => m.status === "pending").length;
  return (
    <>
      <p className="kicker">L2 · orchestration</p>
      <h1>How everything is wired</h1>
      <p className="lede">
        L2 is the first layer with a decision problem. A fleet target (kW for
        a duration) is split across eligible devices without breaching a
        customer&apos;s SoC floor or a site&apos;s export limit. L1 still
        carries the message; L2 decides the number on it.
      </p>

      <div className="orch-hero">
        <p>
          The questions this layer answers are: <em>did it land</em>, and{" "}
          <em>is the failsafe configured?</em>
        </p>
      </div>

      <div className="panel">
        <h2>Dispatch loop</h2>
        <p className="orch-copy">
          Same threshold → static list as L0. What changed: DISPATCH_LOG is
          written before send, each device gets a CHANNEL_MESSAGE, Channel.send
          takes on_ack, and a timeout watcher retries or fails. Overlap skip
          reads current_dispatch_state.
        </p>
        <pre className="loop">{`for signal in incoming_signals:
    matching_rules = ThresholdRule.where(source, is_active).order_by(priority)
    for rule in matching_rules:
        if compare(signal.value, rule.comparator, rule.threshold_value):
            if DispatchLog.exists(rule_id, signal_id): continue
            event = DispatchLog.create(...)          # before send
            for device in list.devices:
                if device.device_status != 'active': continue
                if device.current_dispatch_state == 'dispatched': continue
                send_dispatch_attempt(device, event, instruction, attempt=1)

# handle_ack / timeout_watcher act only while status is still pending
# nack or timeout → new CHANNEL_MESSAGE row (retry chain), else failed`}</pre>
        <RuntimeFlow data={data} result={result} />
      </div>

      <ol className="orch-steps">
        <li>
          <strong>A signal arrives with a signal_id.</strong> Idempotency is
          still <span className="mono">(rule_id, signal_id)</span> on{" "}
          <span className="mono">DISPATCH_LOG</span>. The unique index is the
          guarantee; without it L1 would arm two racing ack timers.
        </li>
        <li>
          <strong>Rules are selected by name, then ordered.</strong> Active{" "}
          <span className="mono">THRESHOLD_RULE</span> rows whose{" "}
          <span className="mono">signal_source</span> matches, sorted by{" "}
          <span className="mono">priority</span> (lower first). Overlapping
          rules both fire. A device already{" "}
          <span className="mono">dispatched</span> is skipped so two in-flight
          instructions do not overlap — that is not “once per signal.”
        </li>
        <li>
          <strong>One comparison, the same for the whole list.</strong>{" "}
          <span className="mono">compare(value, comparator, threshold)</span>.
          If it fails: no messages, no log row.
        </li>
        <li>
          <strong>The list is still static.</strong> Membership was decided
          when someone edited the list. L1 will not drop a device because its
          battery is empty — that is L2 slack. It will skip{" "}
          <span className="mono">paused</span> /{" "}
          <span className="mono">decommissioned</span>, and skip{" "}
          <span className="mono">current_dispatch_state == dispatched</span>.
        </li>
        <li>
          <strong>device_status and current_dispatch_state stay separate.</strong>{" "}
          <span className="mono">device_status</span> is operator reachability
          (active / paused / decommissioned).{" "}
          <span className="mono">current_dispatch_state</span> is a denormalized
          cache of the latest dispatch CHANNEL_MESSAGE (idle / dispatched /
          completed / failed). Source of truth is the message row.
        </li>
        <li>
          <strong>Channel.send takes on_ack.</strong> Each send creates a
          pending <span className="mono">CHANNEL_MESSAGE</span>.{" "}
          <span className="mono">handle_ack</span> and{" "}
          <span className="mono">timeout_watcher</span> only act if status is
          still pending — the race guard. Retries are new chained rows, not
          mutated originals. <span className="mono">MAX_DISPATCH_RETRIES=2</span>.
        </li>
        <li>
          <strong>Config sync is a second, independent loop.</strong> Changing{" "}
          <span className="mono">reserve_bound_pct</span> marks the device{" "}
          <span className="mono">stale</span> and pushes{" "}
          <span className="mono">FAILSAFE_RESERVE</span>.{" "}
          <span className="mono">event_id</span> is null.{" "}
          <span className="mono">MAX_CONFIG_RETRIES=3</span>. Exhausted retries
          set <span className="mono">config_status=failed</span> — a human,
          not L2 substitution.
        </li>
      </ol>

      <div className="row">
        <div className="panel">
          <h2>Who is on the map</h2>
          <p className="orch-copy">
            Reachability is still a join. What L1 adds is per-device delivery
            state: DEVICE carries dispatch and config caches; CHANNEL_MESSAGE
            is the tape.
          </p>
          <RegistryFlow data={data} />
          <dl className="orch-dl">
            <div>
              <dt>SITE</dt>
              <dd>Where the asset sits, including the utility territory.</dd>
            </div>
            <div>
              <dt>CHANNEL</dt>
              <dd>How to address it — phone number, relay, or API endpoint.</dd>
            </div>
            <div>
              <dt>DEVICE</dt>
              <dd>
                Nameplate kW, <span className="mono">device_status</span>,{" "}
                <span className="mono">current_dispatch_state</span>,{" "}
                <span className="mono">config_status</span>.{" "}
                <span className="mono">reserve_bound_pct</span> is the failsafe
                payload L1 actually reads.
              </dd>
            </div>
            <div>
              <dt>BROADCAST_LIST</dt>
              <dd>The fan-out set. Many-to-many via LIST_MEMBERSHIP.</dd>
            </div>
            <div>
              <dt>THRESHOLD_RULE</dt>
              <dd>
                Named source, comparator, threshold, list, fixed instruction,{" "}
                <span className="mono">priority</span>, <span className="mono">is_active</span>.
              </dd>
            </div>
            <div>
              <dt>DISPATCH_LOG</dt>
              <dd>
                Audit that a rule fired, keyed by <span className="mono">signal_id</span>.
                Written before send. Still no per-device ack — that lives on
                CHANNEL_MESSAGE.
              </dd>
            </div>
            <div>
              <dt>CHANNEL_MESSAGE</dt>
              <dd>
                Source of truth for delivery.{" "}
                <span className="mono">dispatch_instruction</span> or{" "}
                <span className="mono">config_sync</span>. Status pending /
                acked / nacked / timed_out. Retries chain via{" "}
                <span className="mono">retry_of_message_id</span>.
              </dd>
            </div>
          </dl>
        </div>
        <div className="panel">
          <h2>Where this sits</h2>
          <p className="orch-copy">
            L0 stays a registry. L1 adds the return path and the failsafe
            push. L2 is where a different device would be substituted, and
            where reserve_bound_pct becomes slack.
          </p>
          <LayerStack />
          <table>
            <thead>
              <tr>
                <th>In L1</th>
                <th>Deliberately absent</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="mono">CHANNEL_MESSAGE</span> per device
                </td>
                <td>Device substitution (L2)</td>
              </tr>
              <tr>
                <td>ack / nack / timeout + retry chain</td>
                <td>
                  <span className="mono">capacity_available</span> / slack
                </td>
              </tr>
              <tr>
                <td>
                  <span className="mono">current_dispatch_state</span> cache
                </td>
                <td>Optimization / merit order</td>
              </tr>
              <tr>
                <td>
                  Config sync of <span className="mono">reserve_bound_pct</span>
                </td>
                <td>Ack authenticity / aggregate channel failure</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>A pass through this fleet</h2>
        <p className="orch-copy">
          {data.devices.length} devices are registered, {listed.size} of them
          sit on at least one list, {data.rules.length} rules are armed,{" "}
          {data.messages.length} CHANNEL_MESSAGE rows, {pending} pending.
          {result
            ? ` Last signal ${result.signal.source} = ${result.signal.value} matched ${result.matching_rule_ids.length} rule(s) and fired ${result.fired_event_ids.length}.`
            : " Inject a signal to see this paragraph fill in with a real pass."}
        </p>
        <CompactFlow data={data} result={result} bare />
        {data.rules.map((r) => {
          const lst = data.lists.find((l) => l.list_id === r.list_id);
          const n = lst?.device_ids.length ?? 0;
          return (
            <div className="trace-card" key={r.rule_id}>
              <strong className="mono">{r.rule_id}</strong>
              <div>
                If <span className="mono">{r.signal_source} {r.comparator} {r.threshold_value}</span>,
                send <span className="pill amber">{r.fixed_instruction}</span> to{" "}
                {n} device{n === 1 ? "" : "s"} on {lst?.name ?? r.list_id} — each
                as a pending CHANNEL_MESSAGE.
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
