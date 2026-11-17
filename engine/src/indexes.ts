import type { Hono } from "hono";
import { TWAP_WINDOWS, twap, twapRule, twapUpdate } from "./chain/twap.ts";
import { encodeAbiParameters, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { feedById } from "./registry.ts";
import { collect, type Source } from "./collect.ts";
import type { Ctx } from "./ctx.ts";
import type { Helpers } from "./server.ts";
import type { PricePoint } from "./chain/prices.ts";
import { HttpError, iso, nowSec, ZERO } from "./util.ts";

export const oracleAbi = parseAbi([
  "function post(bytes32 id, int256 value, uint64 timestamp, bytes signature)",
  "function latest(bytes32 id) view returns (int256 value, uint64 timestamp)",
  "function signer() view returns (address)",
]);

/** Index values carry 8 decimals as integers, like the price feeds they are built from. */
const SCALE = 10n ** 8n;
const BASE = 1000n * SCALE;

export interface IndexDef {
  id: string;
  title: string;
  about: string;
  symbols: string[];
}
/** Equal-weighted baskets of on-chain price feeds. Membership is fixed here and changes only with a new version. */
export const INDEXES: IndexDef[] = [
  { id: "ai", title: "Specula AI Index", about: "Companies that build the chips, clouds and models AI runs on.", symbols: ["NVDA", "AMD", "TSM", "ASML", "MU", "MSFT", "GOOGL", "META", "AMZN", "ORCL", "PLTR", "CRWV", "NBIS", "DELL"] },
  { id: "equities", title: "Specula On-chain Equities Index", about: "Every single stock with a price feed on the chain.", symbols: ["AAPL", "AMD", "AMZN", "ASML", "BABA", "CLSK", "COIN", "CRCL", "CRWV", "DELL", "GME", "GOOGL", "INTC", "IONQ", "META", "MSFT", "MSTR", "MU", "NBIS", "NVDA", "ORCL", "PLTR", "RGTI", "RKLB", "SNDK", "TSLA", "TSM"] },
  { id: "majors", title: "Specula Crypto Majors Index", about: "Bitcoin and Ether, equal weight.", symbols: ["BTC", "ETH"] },
];
const defOf = (id: string) => {
  const d = INDEXES.find((x) => x.id === id.toLowerCase());
  if (!d) throw new HttpError(404, "unknown_index", `Unknown index. Known: ${INDEXES.map((x) => x.id).join(", ")}.`);
  return d;
};

interface Parts {
  [symbol: string]: string; // raw price at this point
}
const lastPoint = (ctx: Ctx, idx: string) => ctx.db.prepare("SELECT time, value, parts FROM index_points WHERE index_id = ? ORDER BY time DESC LIMIT 1").get(idx) as { time: number; value: string; parts: string } | undefined;

/**
 * One step of every index. The new value is the old value times the average price relative of the members that have
 * a price at both points. The first point is the base, 1000. Integer math throughout.
 */
export async function stepIndexes(ctx: Ctx) {
  const board = await collect(ctx, feedById("chain.prices")!, { kind: "all" }, 60);
  const px = new Map(((board.data as { prices: PricePoint[] }).prices ?? []).map((p) => [p.symbol, p.raw]));
  const t = board.collectedAt;
  for (const def of INDEXES) {
    const parts: Parts = {};
    for (const s of def.symbols) if (px.has(s)) parts[s] = px.get(s)!;
    if (!Object.keys(parts).length) continue;
    const prev = lastPoint(ctx, def.id);
    let value = BASE;
    if (prev) {
      if (prev.time >= t) continue;
      const was = JSON.parse(prev.parts) as Parts;
      let sum = 0n;
      let n = 0n;
      for (const [s, now] of Object.entries(parts)) {
        if (!was[s] || BigInt(was[s]) <= 0n) continue;
        sum += (BigInt(now) * SCALE * SCALE) / BigInt(was[s]); // relative with 16 decimals
        n++;
      }
      value = n ? (BigInt(prev.value) * (sum / n)) / (SCALE * SCALE) : BigInt(prev.value);
      if (value === BigInt(prev.value) && JSON.stringify(was) === JSON.stringify(parts)) continue; // nothing moved: no new point
    }
    ctx.db.prepare("INSERT OR IGNORE INTO index_points (index_id, time, value, parts) VALUES (?, ?, ?, ?)").run(def.id, t, value.toString(), JSON.stringify(parts));
  }
}

const fmt = (v: string | bigint) => {
  const s = BigInt(v).toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8, -6)}`;
};

function shape(ctx: Ctx, def: IndexDef) {
  const p = lastPoint(ctx, def.id);
  if (!p) throw new Error("this index has not been computed yet");
  const first = ctx.db.prepare("SELECT time FROM index_points WHERE index_id = ? ORDER BY time LIMIT 1").get(def.id) as { time: number };
  const dayAgo = ctx.db.prepare("SELECT value FROM index_points WHERE index_id = ? AND time <= ? ORDER BY time DESC LIMIT 1").get(def.id, p.time - 86400) as { value: string } | undefined;
  const parts = JSON.parse(p.parts) as Parts;
  return {
    index: def.id,
    title: def.title,
    about: def.about,
    method: "Equal weight. Each step multiplies the value by the average price relative of the members. Base 1000 at the first point.",
    value: fmt(p.value),
    valueRaw: p.value,
    decimals: 8,
    base: "1000",
    at: iso(p.time),
    since: iso(first.time),
    change24hBps: dayAgo ? Number(((BigInt(p.value) - BigInt(dayAgo.value)) * 10000n) / BigInt(dayAgo.value)) : null,
    constituents: def.symbols.map((s) => ({ symbol: s, priced: s in parts, price: parts[s] ? fmt(parts[s]) : null })),
  };
}

export const indexSources: { value: Source; history: Source } = {
  value: { id: "engine", run: async (ctx, p) => ({ data: shape(ctx, defOf(p.index)) }) },
  history: {
    id: "engine",
    async run(ctx, p) {
      const def = defOf(p.index);
      const rows = ctx.db.prepare("SELECT time, value FROM index_points WHERE index_id = ? ORDER BY time DESC LIMIT ?").all(def.id, Number(p.limit ?? 200)) as { time: number; value: string }[];
      if (!rows.length) throw new Error("this index has not been computed yet");
      return { data: { index: def.id, title: def.title, points: rows.reverse().map((r) => ({ at: iso(r.time), value: fmt(r.value) })) } };
    },
  },
};

export const oracleId = (name: string): Hex => stringToHex(name, { size: 32 });

/** A report anyone can carry to the oracle contract: the contract checks the engine's signature, not the sender. */
export async function oracleReport(ctx: Ctx, name: string, value: bigint, timestamp: number) {
  const id = oracleId(name);
  const oracle = ctx.cfg.oracle ?? ZERO;
  const hash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "int256" }, { type: "uint64" }], [BigInt(ctx.cfg.payChainId), oracle, id, value, BigInt(timestamp)]));
  const signature = await ctx.signer.signMessage({ message: { raw: hash } });
  return { name, id, value: value.toString(), decimals: 8, timestamp, chainId: ctx.cfg.payChainId, oracle: ctx.cfg.oracle, signer: ctx.signer.address.toLowerCase(), signature };
}

export function registerIndexes(app: Hono, ctx: Ctx, h: Helpers) {
  app.get("/v1/indexes", async (c) =>
    c.json(
      await h.cached("indexes", 3000, () => ({
        indexes: INDEXES.map((d) => {
          try {
            const s = shape(ctx, d);
            const spark = (ctx.db.prepare("SELECT time, value FROM index_points WHERE index_id = ? ORDER BY time DESC LIMIT 120").all(d.id) as { time: number; value: string }[]).reverse().map((r) => ({ t: r.time, v: Number(fmt(r.value)) }));
            return { ...s, points: spark };
          } catch {
            return { index: d.id, title: d.title, about: d.about, value: null, constituents: d.symbols.map((s) => ({ symbol: s, priced: false, price: null })), points: [] };
          }
        }),
        oracle: { contract: ctx.cfg.oracle, deployed: !!ctx.cfg.oracle },
      })),
    ),
  );
  /** A signed report for the oracle contract. Names: an index id ("index:ai") or a price symbol ("price:NVDA"). */
  app.get("/v1/oracle/:name", async (c) => {
    h.limit(c, "oracle", 60);
    const name = c.req.param("name");
    const [kind, key] = name.split(":");
    if (kind === "index") {
      const p = lastPoint(ctx, defOf(key ?? "").id);
      if (!p) throw new HttpError(503, "not_ready", "This index has not been computed yet.");
      return c.json(await oracleReport(ctx, `index:${key.toLowerCase()}`, BigInt(p.value), p.time));
    }
    if (kind === "price") {
      const d = await collect(ctx, feedById("chain.price")!, { symbol: (key ?? "").toUpperCase() }, 30);
      const pt = d.data as PricePoint;
      return c.json(await oracleReport(ctx, `price:${pt.symbol}`, BigInt(pt.raw), pt.updatedAtSec));
    }
    if (kind === "token") {
      // A signed update for the token price oracle: the time-weighted price, or "thin market" when there is none.
      const token = (key ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) throw new HttpError(400, "bad_param", '"token:<address>" needs a token contract address.');
      const window = TWAP_WINDOWS[c.req.query("window") ?? "30m"];
      if (!window) throw new HttpError(400, "bad_param", `"window" must be one of: ${Object.keys(TWAP_WINDOWS).join(", ")}`);
      return c.json(await twapUpdate(ctx, twap(ctx, token, twapRule(window))));
    }
    throw new HttpError(400, "bad_param", 'Use "index:<id>", "price:<symbol>" or "token:<address>".');
  });
}
