import { randomBytes } from "node:crypto";
import { getAddress, isAddress as viemIsAddress, parseUnits, formatUnits, type Address } from "viem";

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const DEAD = "0x000000000000000000000000000000000000dead" as Address;

/** Lowercase is the stored form of every address; checksummed is for display only. */
export const lower = (a: string): Address => a.toLowerCase() as Address;
export const isAddress = (a: unknown): a is Address => typeof a === "string" && viemIsAddress(a, { strict: false });
export const checksum = (a: string): Address => getAddress(a);
/** Case-insensitive address compare. Falls back to exact equality when either side is not an address. */
export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  if (isAddress(a) && isAddress(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
};

export const nowSec = () => Math.floor(Date.now() / 1000);
export const iso = (sec: number) => new Date(sec * 1000).toISOString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

/** Money: a decimal string is parsed to base units once, on the digits. Arithmetic is on bigint only. */
export const toUnits = (text: string, decimals: number): bigint => parseUnits(text as `${number}`, decimals);
export const fromUnits = (units: bigint | string, decimals: number): string => formatUnits(BigInt(units), decimals);

/** Canonical JSON: keys sorted at every level, no whitespace. The same value always gives the same bytes. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const maskAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}

/** Integer ratio in basis points, rounded down. */
export const bps = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 10000n) / whole));
