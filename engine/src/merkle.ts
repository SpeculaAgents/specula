import type { Hono } from "hono";
import { keccak256, parseAbi, type Hex } from "viem";
import { count, type Ctx } from "./ctx.ts";
import { relay } from "./gas.ts";
import type { Helpers } from "./server.ts";
import { signValue } from "./sign.ts";
import { HttpError, iso, nowSec } from "./util.ts";

export const anchorAbi = parseAbi([
  "function anchor(uint64 hour, bytes32 root, uint32 count)",
  "function roots(uint64 hour) view returns (bytes32 root, uint32 count, uint64 anchoredAt)",
  "function verify(uint64 hour, bytes32 leaf, bytes32[] proof) view returns (bool)",
]);

const pair = (a: Hex, b: Hex): Hex => (a.toLowerCase() < b.toLowerCase() ? keccak256(`0x${a.slice(2)}${b.slice(2)}`) : keccak256(`0x${b.slice(2)}${a.slice(2)}`));

/** A Merkle tree over sorted leaves with sorted pairs. An odd node is carried up unchanged. */
export function merkle(leaves: Hex[]): { root: Hex; proof: (leaf: Hex) => Hex[] | null } {
  const base = [...new Set(leaves.map((l) => l.toLowerCase() as Hex))].sort();
  const levels: Hex[][] = [base];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return {
    root: base.length ? levels[levels.length - 1][0] : (`0x${"0".repeat(64)}` as Hex),
    proof(leaf) {
      let i = base.indexOf(leaf.toLowerCase() as Hex);
      if (i < 0) return null;
      const out: Hex[] = [];
      for (let l = 0; l < levels.length - 1; l++) {
        const sib = i ^ 1;
        if (sib < levels[l].length) out.push(levels[l][sib]);
        i >>= 1;
      }
      return out;
    },
  };
}

const leavesOf = (ctx: Ctx, hour: number) => (ctx.db.prepare("SELECT digest FROM leaves WHERE hour = ?").all(hour) as { digest: Hex }[]).map((r) => r.digest);

/** Seal every finished hour that has answers and no root yet. With an anchor contract configured, post the root. */
export async function sealHours(ctx: Ctx): Promise<number> {
  const current = Math.floor(nowSec() / 3600);
  const hours = (ctx.db.prepare("SELECT DISTINCT hour FROM leaves WHERE hour < ? AND hour NOT IN (SELECT hour FROM roots) ORDER BY hour").all(current) as { hour: number }[]).map((r) => r.hour);
  for (const hour of hours) {
    const leaves = leavesOf(ctx, hour);
    const { root } = merkle(leaves);
    const n = new Set(leaves).size;
    const { signature } = await signValue(ctx, { hour, root, count: n });
    ctx.db.prepare("INSERT OR IGNORE INTO roots (hour, root, count, at, signature) VALUES (?, ?, ?, ?, ?)").run(hour, root, n, nowSec(), signature);
    count(ctx, "roots_sealed");
  }
  if (ctx.cfg.anchor && ctx.relayer?.account) {
    for (const r of ctx.db.prepare("SELECT hour, root, count FROM roots WHERE tx IS NULL ORDER BY hour LIMIT 24").all() as { hour: number; root: Hex; count: number }[]) {
      try {
        // Through the gas book like every relayed call: estimated first, capped, and counted for the day.
        const { hash, receipt: rc } = await relay(ctx, "anchor", "engine:anchor", { address: ctx.cfg.anchor, abi: anchorAbi, functionName: "anchor", args: [BigInt(r.hour), r.root, r.count] });
        if (rc.status === "success") ctx.db.prepare("UPDATE roots SET tx = ? WHERE hour = ?").run(hash, r.hour);
      } catch (e) {
        console.warn("[anchor] could not post the root for hour", r.hour, String((e as Error).message).slice(0, 100));
        break;
      }
    }
  }
  return hours.length;
}

const shapeRoot = (ctx: Ctx, r: { hour: number; root: string; count: number; at: number; signature: string; tx: string | null }) => ({ hour: r.hour, from: iso(r.hour * 3600), to: iso((r.hour + 1) * 3600), root: r.root, answers: r.count, sealedAt: iso(r.at), engine: ctx.signer.address.toLowerCase(), signature: r.signature, anchored: r.tx ? { transaction: r.tx, contract: ctx.cfg.anchor } : null });

export function registerVerify(app: Hono, ctx: Ctx, h: Helpers) {
  app.get("/v1/roots", async (c) =>
    c.json(
      await h.cached("roots", 3000, () => {
        const rows = ctx.db.prepare("SELECT * FROM roots ORDER BY hour DESC LIMIT 48").all() as Parameters<typeof shapeRoot>[1][];
        const hour = Math.floor(nowSec() / 3600);
        return { anchor: ctx.cfg.anchor, engine: ctx.signer.address.toLowerCase(), openHour: { hour, answersSoFar: leavesOf(ctx, hour).length, sealsAt: iso((hour + 1) * 3600) }, sealed: (ctx.db.prepare("SELECT COUNT(*) n FROM roots").get() as { n: number }).n, roots: rows.map((r) => shapeRoot(ctx, r)) };
      }),
    ),
  );
  // A sealed hour never changes, so its tree is built once and kept for the next few proofs.
  const trees = new Map<number, ReturnType<typeof merkle>>();
  const treeOf = (hour: number) => {
    let t = trees.get(hour);
    if (!t) {
      t = merkle(leavesOf(ctx, hour));
      if (trees.size >= 8) trees.delete(trees.keys().next().value!);
      trees.set(hour, t);
    }
    return t;
  };
  app.get("/v1/proof/:digest", (c) => {
    h.limit(c, "proof", 120);
    const digest = c.req.param("digest").toLowerCase() as Hex;
    const leaf = ctx.db.prepare("SELECT * FROM leaves WHERE digest = ?").get(digest) as { hour: number; feed: string; at: number } | undefined;
    if (!leaf) throw new HttpError(404, "unknown_digest", "This engine never signed an answer with that digest.");
    const root = ctx.db.prepare("SELECT * FROM roots WHERE hour = ?").get(leaf.hour) as Parameters<typeof shapeRoot>[1] | undefined;
    if (!root) return c.json({ digest, feed: leaf.feed, collectedAt: iso(leaf.at), sealed: false, sealsAt: iso((leaf.hour + 1) * 3600) });
    return c.json({ digest, feed: leaf.feed, collectedAt: iso(leaf.at), sealed: true, proof: treeOf(leaf.hour).proof(digest), ...shapeRoot(ctx, root) });
  });
}
