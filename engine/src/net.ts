import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { HttpError } from "./util.ts";

/**
 * Outbound requests to addresses a stranger chose (a seller's endpoint). Only public https: the host is resolved
 * once, every address it resolves to must be public, and the connection goes to exactly the address that was
 * checked, so a second DNS answer cannot point it somewhere else. Redirects are never followed; size and time are capped.
 */

const V4_REFUSED: [number, number, string][] = [
  [0x00000000, 8, "this network"],
  [0x0a000000, 8, "private"],
  [0x64400000, 10, "shared address space"],
  [0x7f000000, 8, "loopback"],
  [0xa9fe0000, 16, "link-local or cloud metadata"],
  [0xac100000, 12, "private"],
  [0xc0000000, 24, "protocol assignments"],
  [0xc0000200, 24, "documentation"],
  [0xc01fc400, 24, "reserved"],
  [0xc034c100, 24, "reserved"],
  [0xc0586300, 24, "6to4 relay"],
  [0xc0a80000, 16, "private"],
  [0xc0af3000, 24, "reserved"],
  [0xc6120000, 15, "benchmarking"],
  [0xc6336400, 24, "documentation"],
  [0xcb007100, 24, "documentation"],
  [0xe0000000, 4, "multicast"],
  [0xf0000000, 4, "reserved"],
];

function v4(ip: string): number {
  return ip.split(".").reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
}

/** Sixteen bytes of an IPv6 address, or null when it is not one (a zone id counts as not one). */
export function v6bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6 || ip.includes("%")) return null;
  let s = ip.toLowerCase();
  // A dotted IPv4 tail becomes two groups.
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4(tail[1]);
    s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const groups = rest === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

const prefix = (bytes: number[], want: number[], bits: number) => {
  for (let i = 0; i < bits; i++) {
    const bit = (x: number[]) => (x[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit(bytes) !== bit(want)) return false;
  }
  return true;
};
const hex6 = (s: string) => v6bytes(s)!;

const V6_REFUSED: [number[], number, string][] = [
  [hex6("::"), 96, "IPv4-compatible or unspecified"],
  [hex6("::ffff:0:0"), 96, "IPv4-mapped"],
  [hex6("64:ff9b::"), 96, "NAT64"],
  [hex6("64:ff9b:1::"), 48, "NAT64"],
  [hex6("2002::"), 16, "6to4"],
  [hex6("2001::"), 32, "Teredo"],
  [hex6("2001::"), 23, "protocol assignments"],
  [hex6("2001:db8::"), 32, "documentation"],
  [hex6("3fff::"), 20, "documentation"],
];

/** Why an address is not on the public internet, or null when it is. */
export function refusalOf(ip: string): string | null {
  if (isIP(ip) === 4) {
    const n = v4(ip);
    for (const [base, bits, why] of V4_REFUSED) if (n >>> (32 - bits) === base >>> (32 - bits)) return why;
    return null;
  }
  const b = v6bytes(ip);
  if (!b) return "not an address";
  for (const [base, bits, why] of V6_REFUSED) if (prefix(b, base, bits)) return why;
  // Only global unicast (2000::/3) is public. Loopback, unique local, link-local and multicast all fall outside it.
  if (!prefix(b, hex6("2000::"), 3)) return "not global unicast";
  return null;
}

const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa|onion|test|invalid|example)$/i;

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const dnsResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

export interface Target {
  url: URL;
  /** The host as written, without brackets: what TLS checks the certificate against. */
  host: string;
  /** The checked address the connection must go to. */
  address: string;
}

/** Parse, then resolve and check. Throws a 400 "bad_url" with a plain reason. */
export async function publicTarget(raw: string, resolver: Resolver = dnsResolver): Promise<Target> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "bad_url", "The endpoint is not a valid URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new HttpError(400, "bad_url", "The endpoint must be a plain https URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const literal = isIP(host) !== 0;
  if (!literal && (!host.includes(".") || INTERNAL_NAMES.test(host))) throw new HttpError(400, "bad_url", "The endpoint must be on the public internet.");
  const addrs = literal ? [host] : (await resolver(host).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, "bad_url", "The endpoint's host does not resolve.");
  if (addrs.some((a) => refusalOf(a) !== null)) throw new HttpError(400, "bad_url", "The endpoint must be on the public internet.");
  return { url: u, host, address: addrs[0] };
}

export interface Fetched {
  status: number;
  text: string;
}

export class TooLarge extends Error {}

/**
 * GET over https to exactly `address`, with the URL's host for TLS and the Host header. No redirects, at most
 * `maxBytes` of body, at most `timeoutMs` in all. `ca` is for tests with their own certificate.
 */
export function fetchPinned(t: Target, o: { timeoutMs: number; maxBytes: number; headers?: Record<string, string>; ca?: string | Buffer }): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const literal = isIP(t.host) !== 0;
    let settled = false;
    const done = (err: Error | null, value?: Fetched) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(value!);
    };
    const req = request({
      host: t.address,
      port: t.url.port || 443,
      path: `${t.url.pathname}${t.url.search}`,
      method: "GET",
      headers: { ...o.headers, Host: t.url.host },
      servername: literal ? undefined : t.host,
      // The certificate must be for the host as written, whatever address we connected to.
      checkServerIdentity: (_h, cert) => checkServerIdentity(literal ? t.address : t.host, cert),
      agent: false,
      ca: o.ca,
    });
    const timer = setTimeout(() => done(new Error(`no complete answer within ${o.timeoutMs} ms`)), o.timeoutMs);
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) return done(new Error(`the endpoint answered ${status} (a redirect, not followed)`));
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) return done(new TooLarge(`larger than ${Math.round(o.maxBytes / 1024)} KB`));
        chunks.push(c);
      });
      res.on("end", () => done(null, { status, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => done(e));
      res.on("aborted", () => done(new Error("the endpoint closed the connection")));
    });
    req.on("error", (e) => done(e));
    req.end();
  });
}

/** Read a fetch Response body, refusing more than `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge(`larger than ${Math.round(maxBytes / 1024)} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
