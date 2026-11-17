import { bps } from "./format";

/** What a signal saw, in a few words. Empty when the fire carries nothing worth a line. */
export function fireDetail(d: Record<string, unknown>): string {
  if (typeof d.moveBps === "number") return `${bps(d.moveBps)} from ${String(d.from)} to ${String(d.to)}`;
  if (d.valueUsd && d.side) return `${String(d.side)} of $${Number(d.valueUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (d.form) return `${String(d.form)} filed ${String(d.filedAt)}`;
  if (d.buysInFirst10s) return `${String(d.buysInFirst10s)} buys in the first 10 seconds`;
  if (d.name) return String(d.name);
  if (d.level) return `crossed ${String(d.level)}`;
  return "";
}
