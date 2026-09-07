import type { ChannelMessage, Device } from "./types";

export function dispatchClass(s: Device["current_dispatch_state"]): string {
  if (s === "completed") return "pill green";
  if (s === "dispatched") return "pill amber";
  if (s === "failed") return "pill red";
  return "pill";
}

export function configClass(s: Device["config_status"]): string {
  if (s === "synced") return "pill green";
  if (s === "pending") return "pill amber";
  if (s === "stale") return "pill cyan";
  if (s === "failed") return "pill red";
  return "pill";
}

export function messageClass(s: ChannelMessage["status"]): string {
  if (s === "acked") return "pill green";
  if (s === "pending") return "pill amber";
  return "pill red";
}
