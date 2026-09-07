import * as l0 from "./l0";
import type { Snapshot, SignalResult } from "./types";

function wrap<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn);
}

export const api = {
  snapshot: () => wrap<Snapshot>(l0.snapshot),
  seed: () => wrap<Snapshot>(l0.seedFleet),
  signal: (source: string, value: number, signalId?: string) =>
    wrap<SignalResult>(() => l0.injectSignal(source, value, signalId)),
  createSite: (body: object) =>
    wrap(() =>
      l0.createSite(body as { site_id?: string; customer_id: string; utility_territory: string }),
    ),
  deleteSite: (id: string) => wrap(() => l0.deleteSite(id)),
  createChannel: (body: object) =>
    wrap(() =>
      l0.createChannel(body as { channel_id?: string; channel_type: string; endpoint: string }),
    ),
  deleteChannel: (id: string) => wrap(() => l0.deleteChannel(id)),
  createDevice: (body: object) =>
    wrap(() =>
      l0.createDevice(
        body as {
          device_id?: string;
          site_id: string;
          channel_id: string;
          device_class: string;
          rated_capacity_kw: number;
          reserve_bound_pct: number;
          device_status?: "active" | "paused" | "decommissioned";
        },
      ),
    ),
  deleteDevice: (id: string) => wrap(() => l0.deleteDevice(id)),
  createList: (body: object) =>
    wrap(() => l0.createList(body as { list_id?: string; name: string })),
  deleteList: (id: string) => wrap(() => l0.deleteList(id)),
  addMember: (listId: string, deviceId: string) => wrap(() => l0.addMember(listId, deviceId)),
  removeMember: (listId: string, deviceId: string) => wrap(() => l0.removeMember(listId, deviceId)),
  createRule: (body: object) =>
    wrap(() =>
      l0.createRule(
        body as {
          rule_id?: string;
          signal_source: string;
          comparator: string;
          threshold_value: number;
          list_id: string;
          fixed_instruction: string;
          priority?: number;
          is_active?: boolean;
          instruction_type?: "fixed" | "fleet_target";
          target_kw?: number | null;
          duration_min?: number | null;
        },
      ),
    ),
  deleteRule: (id: string) => wrap(() => l0.deleteRule(id)),
  tick: () => wrap(() => l0.tickTimeouts()),
  configSync: (deviceId?: string) => wrap(() => l0.syncConfig(deviceId)),
  telemetrySeed: () => wrap(() => l0.seedTelemetry()),
  release: (eventId: string) => wrap(() => l0.releaseEvent(eventId)),
  setOptOut: (deviceId: string, until: string | null) => wrap(() => l0.setOptOut(deviceId, until)),
};
