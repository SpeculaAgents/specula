import type { AbiEvent, Address, GetLogsReturnType } from "viem";
import type { Ctx } from "../ctx.ts";
import { sleep } from "../util.ts";

const TOO_MANY = /exceeds limit|query timed out|response size|too many results|narrow the block range/i;
const THROTTLED = /\b403\b|\b429\b|Just a moment|rate limit|too many requests/i;

/**
 * Paced eth_getLogs. The public node caps a query at 10,000 results and refuses (it does not truncate), so a refusal
 * splits the range in half; it also throttles bursts, so calls are spaced and a throttle backs off harder than an error.
 */
export async function getLogs<E extends AbiEvent>(
  ctx: Ctx,
  q: { address?: Address | Address[]; event: E; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint },
): Promise<GetLogsReturnType<E, [E], true>> {
  type R = GetLogsReturnType<E, [E], true>;
  const one = async (from: bigint, to: bigint, depth: number): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      const wait = ctx.pace.gapMs - (Date.now() - ctx.pace.last);
      if (wait > 0) await sleep(wait);
      ctx.pace.last = Date.now();
      try {
        return (await ctx.pub.getLogs({ address: q.address, event: q.event, args: q.args as never, fromBlock: from, toBlock: to, strict: true })) as unknown as R;
      } catch (e) {
        let msg = "";
        for (let x = e as { message?: string; details?: string; cause?: unknown } | undefined, i = 0; x && i < 4; x = x.cause as typeof x, i++) msg += ` ${x.message ?? ""} ${x.details ?? ""}`;
        if (TOO_MANY.test(msg) && to > from && depth < 24) {
          // The node answered: a refusal is not a failure. Split and carry on.
          const mid = from + (to - from) / 2n;
          const a = await one(from, mid, depth + 1);
          const b = await one(mid + 1n, to, depth + 1);
          return [...a, ...b] as unknown as R;
        }
        if (attempt >= 4) throw e;
        await sleep(THROTTLED.test(msg) ? ctx.pace.backoffMs * (attempt + 1) * 3 : ctx.pace.backoffMs * (attempt + 1));
      }
    }
  };
  // A query with no address filter may span 30,000 blocks at most (the node says so); with one, stay at 100,000.
  const span = q.address ? 100_000n : 30_000n;
  const out: unknown[] = [];
  for (let from = q.fromBlock; from <= q.toBlock; from += span) {
    const to = from + span - 1n > q.toBlock ? q.toBlock : from + span - 1n;
    out.push(...(await one(from, to, 0)));
  }
  return out as unknown as R;
}

/** Block time without a getBlock per log: two anchors and a straight line (blocks are steady at about 0.1 s). */
export async function blockClock(ctx: Ctx): Promise<(block: bigint) => number> {
  const cached = ctx.mem.get("clock") as { at: number; fn: (b: bigint) => number } | undefined;
  if (cached && Date.now() - cached.at < 60_000) return cached.fn;
  const latest = await ctx.pub.getBlock();
  const span = latest.number > 20_000n ? 20_000n : latest.number;
  const older = span > 0n ? await ctx.pub.getBlock({ blockNumber: latest.number - span }) : latest;
  const perBlock = span > 0n ? Number(latest.timestamp - older.timestamp) / Number(span) : 0;
  const fn = (b: bigint) => Math.round(Number(latest.timestamp) - Number(latest.number - b) * perBlock);
  ctx.mem.set("clock", { at: Date.now(), fn });
  return fn;
}
