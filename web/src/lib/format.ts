/** Every number on the site goes through here. */
export function price(v: string | number | null | undefined, quote = "USD"): string {
  if (v === null || v === undefined || v === "") return "n/a";
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  const digits = quote !== "USD" ? 6 : n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits });
}
export const int = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : Math.round(n).toLocaleString("en-US"));
export const usd = (v: string | number | null | undefined) => (v === null || v === undefined ? "n/a" : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) >= 100 ? 0 : 2 })}`);
export const pct = (ratio: number | null | undefined, digits = 2) => (ratio === null || ratio === undefined ? "n/a" : `${(ratio * 100).toFixed(digits)}%`);
export const bps = (b: number | null | undefined) => (b === null || b === undefined ? "n/a" : `${b > 0 ? "+" : ""}${(b / 100).toFixed(2)}%`);
export const short = (a: string, head = 6, tail = 4) => (a.length > head + tail + 2 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a);
export const tiny = (v: string | number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return n.toPrecision(3).replace(/\.?0+$/, "");
};

export function ago(when: string | number | null | undefined, now = Date.now()): string {
  if (when === null || when === undefined) return "n/a";
  const t = typeof when === "number" ? when * 1000 : Date.parse(when);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const utc = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "n/a");
export const span = (sec: number) => (sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} d`);
