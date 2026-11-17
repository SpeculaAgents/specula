// Chain intelligence from Specula's own index: who bought a launch in its first blocks, what a deployer launched
// before and what became of it, which holders of a token move together, and which wallets are often early in tokens
// that then rose. Every answer carries its evidence (transactions and blocks) and says only what the index shows.
// Nothing here judges anyone: it describes what happened.
import { formatUnits } from "viem";
import type { Ctx } from "../ctx.ts";
import type { Source } from "../collect.ts";
import { bps, HttpError, iso, lower, nowSec, ZERO } from "../util.ts";
import { ADDR, phaseName } from "./abi.ts";
import { indexHead, type TradeRow } from "./indexer.ts";
import { usdOf } from "./views.ts";

interface TokenRow {
  address: string;
  curve: string | null;
  name: string;
  symbol: string;
  deployer: string;
  launch_block: number;
  launch_time: number;
  launch_seen: number;
  phase: number;
  pool_id: string | null;
  graduated_at: number | null;
  supply: string | null;
}

const needIndex = (ctx: Ctx) => {
  if (indexHead(ctx) === null) throw new HttpError(409, "indexing", "The chain index is reading its first blocks. Ask again in a minute. You were not charged.", { retryAfter: 30 });
};
const coverage = (ctx: Ctx) => {
  const start = ctx.db.prepare("SELECT value FROM kv WHERE key = 'index_start'").get() as { value: string } | undefined;
  const head = indexHead(ctx);
  const first = ctx.db.prepare("SELECT MIN(time) t FROM trades").get() as { t: number | null };
  return { fromBlock: start ? Number(start.value) : null, toBlock: head === null ? null : Number(head), since: first.t ? iso(first.t) : null };
};
const isEth = (asset: string) => asset === ZERO || asset === lower(ADDR.weth);
const eth = (wei: bigint) => formatUnits(wei, 18);
const X18 = 10n ** 18n;
/** ETH per whole token with 18 decimals, from one trade. */
const pxOf = (t: { quote: string; amount: string }) => (BigInt(t.amount) === 0n ? 0n : (BigInt(t.quote) * X18) / BigInt(t.amount));
const launchedToken = (ctx: Ctx, token: string): TokenRow => {
  const r = ctx.db.prepare("SELECT * FROM tokens WHERE address = ?").get(token) as TokenRow | undefined;
  if (!r || !r.launch_seen) throw new HttpError(404, "launch_not_indexed", "This token's launch is not in the indexed window, so its first blocks cannot be read. You were not charged.", { coverage: coverage(ctx) });
  return r;
};
/** Contracts that tokens pass through on every trade. They are venues, not wallets. */
const venuesOf = (r: { curve: string | null }) => new Set<string>([ZERO, lower(ADDR.poolManager), lower(ADDR.ponsFactory), lower(ADDR.ponsEscrow), lower(ADDR.ponsHook), ...(r.curve ? [lower(r.curve)] : [])]);

// ---------- who sniped a launch ----------

export const snipersSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const r = launchedToken(ctx, p.token);
    const blocks = Number(p.blocks ?? 3);
    const lastBlock = r.launch_block + blocks;
    const buys = ctx.db.prepare("SELECT * FROM trades WHERE token = ? AND side = 'buy' AND block <= ? ORDER BY block, log_index").all(r.address, lastBlock) as TradeRow[];
    const supply = r.supply ? BigInt(r.supply) : 0n;
    const sold = ctx.db.prepare("SELECT COALESCE(COUNT(*), 0) n, MIN(block) first FROM trades WHERE token = ? AND trader = ? AND side = 'sell'");
    const soldRows = ctx.db.prepare("SELECT amount, quote FROM trades WHERE token = ? AND trader = ? AND side = 'sell'");
    const held = ctx.db.prepare("SELECT balance FROM holders WHERE token = ? AND holder = ?");
    const holdersKnown = !!ctx.db.prepare("SELECT 1 FROM holder_progress WHERE token = ?").get(r.address);
    const by = new Map<string, TradeRow[]>();
    for (const t of buys) by.set(t.trader, [...(by.get(t.trader) ?? []), t]);
    let totalTokens = 0n;
    let totalEth = 0n;
    const snipers = [...by.entries()].map(([wallet, ts]) => {
      const tokens = ts.reduce((n, t) => n + BigInt(t.amount), 0n);
      const spent = ts.reduce((n, t) => n + BigInt(t.quote), 0n);
      totalTokens += tokens;
      totalEth += spent;
      const sells = soldRows.all(r.address, wallet) as { amount: string; quote: string }[];
      const s = sold.get(r.address, wallet) as { n: number; first: number | null };
      const bal = holdersKnown ? ((held.get(r.address, wallet) as { balance: string } | undefined)?.balance ?? "0") : null;
      return {
        wallet,
        isDeployer: wallet === r.deployer,
        firstBuy: { block: ts[0].block, blocksAfterLaunch: ts[0].block - r.launch_block, secondsAfterLaunch: Math.max(0, ts[0].time - r.launch_time), tx: ts[0].tx },
        buys: ts.length,
        tokensBought: formatUnits(tokens, 18),
        shareOfSupplyBps: bps(tokens, supply),
        spent: eth(spent),
        spentUsd: usdOf(ctx, ts[0].quote_asset, spent),
        since: { sells: s.n, firstSellBlock: s.first, tokensSold: formatUnits(sells.reduce((n, t) => n + BigInt(t.amount), 0n), 18), received: eth(sells.reduce((n, t) => n + BigInt(t.quote), 0n)), stillHolds: bal === null ? null : formatUnits(BigInt(bal), 18) },
        evidence: ts.slice(0, 5).map((t) => ({ tx: t.tx, block: t.block })),
      };
    });
    return {
      data: {
        token: r.address,
        symbol: r.symbol,
        launch: { block: r.launch_block, at: iso(r.launch_time), deployer: r.deployer },
        window: { blocks, fromBlock: r.launch_block, toBlock: lastBlock },
        wallets: snipers.length,
        tokensBought: formatUnits(totalTokens, 18),
        shareOfSupplyBps: bps(totalTokens, supply),
        spent: eth(totalEth),
        snipers,
        method: `A wallet is listed when it bought in the launch block or one of the ${blocks} blocks after it. "since" is what the same wallet did with the token afterwards, as far as the index has read.`,
        coverage: coverage(ctx),
      },
    };
  },
};

// ---------- a deployer's history ----------

export const deployerSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const now = nowSec();
    const rows = ctx.db.prepare("SELECT * FROM tokens WHERE deployer = ? ORDER BY launch_block DESC LIMIT ?").all(p.address, Number(p.limit ?? 25)) as TokenRow[];
    const total = (ctx.db.prepare("SELECT COUNT(*) n FROM tokens WHERE deployer = ?").get(p.address) as { n: number }).n;
    const tokens = rows.map((r) => {
      const st = ctx.db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT trader) traders, MAX(time) last, MAX(block) lastBlock FROM trades WHERE token = ?").get(r.address) as { n: number; traders: number; last: number | null; lastBlock: number | null };
      const lastTrade = ctx.db.prepare("SELECT * FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 1").get(r.address) as TradeRow | undefined;
      const own = ctx.db.prepare("SELECT side, quote, amount, tx, block FROM trades WHERE token = ? AND trader = ? ORDER BY block, log_index").all(r.address, p.address) as { side: string; quote: string; amount: string; tx: string; block: number }[];
      const liq = r.pool_id ? (ctx.db.prepare("SELECT delta, tx, block, time FROM liquidity WHERE pool_id = ? ORDER BY block, log_index").all(r.pool_id) as { delta: string; tx: string; block: number; time: number }[]) : [];
      const net = liq.reduce((n, l) => n + BigInt(l.delta), 0n);
      const removals = liq.filter((l) => BigInt(l.delta) < 0n);
      const lastRemoval = removals[removals.length - 1];
      const liquidityOut = liq.length > 0 && removals.length > 0 && net <= 0n;
      const quietDays = st.last ? Math.floor((now - st.last) / 86400) : null;
      // What happened, in words the data supports and nothing more.
      const what: string[] = [];
      what.push(r.phase === 2 ? "graduated from its curve to a pool" : r.phase === 0 ? "still on its launch curve" : `in the ${phaseName(r.phase)} phase`);
      if (liquidityOut) what.push(`all liquidity the index saw added to its pool was removed again, last at block ${lastRemoval.block}`);
      else if (removals.length) what.push(`liquidity was removed from its pool ${removals.length} ${removals.length === 1 ? "time" : "times"}, and some remains`);
      if (st.n === 0) what.push("no trade in the indexed window");
      else if (quietDays! >= 1) what.push(`no trade for ${quietDays} ${quietDays === 1 ? "day" : "days"}`);
      else what.push("traded in the last day");
      const dSold = own.filter((t) => t.side === "sell");
      if (dSold.length) what.push(`the deployer sold it ${dSold.length} ${dSold.length === 1 ? "time" : "times"}`);
      return {
        token: r.address,
        symbol: r.symbol,
        name: r.name,
        launchedAt: r.launch_seen ? iso(r.launch_time) : null,
        launchBlock: r.launch_seen ? r.launch_block : null,
        phase: phaseName(r.phase),
        graduatedAt: r.graduated_at ? iso(r.graduated_at) : null,
        trades: st.n,
        traders: st.traders,
        lastTradeAt: st.last ? iso(st.last) : null,
        lastPrice: lastTrade && isEth(lastTrade.quote_asset) ? eth(pxOf(lastTrade)) : null,
        ended: liquidityOut ? "liquidity removed" : st.n === 0 ? "no trades seen" : quietDays! >= 1 ? "quiet" : "trading",
        whatHappened: what,
        deployerTrades: {
          buys: own.filter((t) => t.side === "buy").length,
          sells: dSold.length,
          spent: eth(own.filter((t) => t.side === "buy").reduce((n, t) => n + BigInt(t.quote), 0n)),
          received: eth(dSold.reduce((n, t) => n + BigInt(t.quote), 0n)),
          firstSell: dSold[0] ? { tx: dSold[0].tx, block: dSold[0].block } : null,
        },
        liquidity: r.pool_id ? { poolId: r.pool_id, added: liq.length - removals.length, removed: removals.length, allRemoved: liquidityOut, lastRemoval: lastRemoval ? { tx: lastRemoval.tx, block: lastRemoval.block, at: iso(lastRemoval.time) } : null } : null,
      };
    });
    const count = (k: string) => tokens.filter((t) => t.ended === k).length;
    return {
      data: {
        deployer: p.address,
        tokensLaunched: total,
        listed: tokens.length,
        summary: { trading: count("trading"), quiet: count("quiet"), liquidityRemoved: count("liquidity removed"), noTradesSeen: count("no trades seen"), graduated: tokens.filter((t) => t.phase === "pool").length },
        tokens,
        method: "Tokens whose launch names this wallet as deployer. \"ended\" is read from the index: trades, the pool's liquidity events and the deployer's own trades. It describes what happened and is not a judgement of the deployer.",
        coverage: coverage(ctx),
      },
    };
  },
};

// ---------- holders that move together ----------

/** A sender with more recipients than this is treated as a venue or a distributor, not as one wallet funding its own. */
const HUB = 25;

export const clustersSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const r = ctx.db.prepare("SELECT * FROM tokens WHERE address = ?").get(p.token) as TokenRow | undefined;
    if (!r) throw new HttpError(404, "unknown_token", "This token is not in the index. You were not charged.", { coverage: coverage(ctx) });
    const venues = venuesOf(r);
    const supply = r.supply ? BigInt(r.supply) : 0n;
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let x = a;
      while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x)!;
      return x;
    };
    const links: { a: string; b: string; kind: "sent tokens" | "same sender" | "bought together"; detail: string; tx: string | null; block: number | null }[] = [];
    const link = (a: string, b: string, l: Omit<(typeof links)[number], "a" | "b">) => {
      if (a === b) return;
      for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
      links.push({ a, b, ...l });
      const [ra, rb] = [find(a), find(b)];
      if (ra !== rb) parent.set(ra, rb);
    };

    // 1. The token itself moving between wallets: one wallet sending to another, or one wallet sending to several.
    const sends = ctx.db.prepare("SELECT sender, recipient, tx, block, amount FROM transfers WHERE token = ? ORDER BY block, log_index").all(r.address) as { sender: string; recipient: string; tx: string; block: number; amount: string }[];
    const recipients = new Map<string, Set<string>>();
    for (const s of sends) recipients.set(s.sender, (recipients.get(s.sender) ?? new Set()).add(s.recipient));
    const isVenue = (a: string) => venues.has(a) || (recipients.get(a)?.size ?? 0) > HUB;
    const fundedBy = new Map<string, { to: string; tx: string; block: number }[]>();
    for (const s of sends) {
      if (isVenue(s.sender) || isVenue(s.recipient)) continue;
      link(s.sender, s.recipient, { kind: "sent tokens", detail: `${formatUnits(BigInt(s.amount), 18)} sent from one to the other`, tx: s.tx, block: s.block });
      fundedBy.set(s.sender, [...(fundedBy.get(s.sender) ?? []), { to: s.recipient, tx: s.tx, block: s.block }]);
    }
    for (const [sender, outs] of fundedBy) {
      const uniq = [...new Map(outs.map((o) => [o.to, o])).values()];
      for (let i = 1; i < uniq.length; i++) link(uniq[0].to, uniq[i].to, { kind: "same sender", detail: `both received the token from ${sender}`, tx: uniq[i].tx, block: uniq[i].block });
    }

    // 2. Wallets that bought in the same block more than once. Once can be chance; twice or more is a pattern.
    const buys = ctx.db.prepare("SELECT trader, block, tx FROM trades WHERE token = ? AND side = 'buy' ORDER BY block, log_index").all(r.address) as { trader: string; block: number; tx: string }[];
    const perBlock = new Map<number, Map<string, string>>();
    for (const b of buys) perBlock.set(b.block, (perBlock.get(b.block) ?? new Map()).set(b.trader, b.tx));
    const together = new Map<string, { n: number; blocks: number[]; tx: string }>();
    for (const [block, traders] of perBlock) {
      const ws = [...traders.keys()].sort();
      if (ws.length < 2 || ws.length > 12) continue; // a crowded block says nothing about any two wallets in it
      for (let i = 0; i < ws.length; i++)
        for (let j = i + 1; j < ws.length; j++) {
          const k = `${ws[i]}|${ws[j]}`;
          const e = together.get(k) ?? { n: 0, blocks: [], tx: traders.get(ws[i])! };
          e.n++;
          e.blocks.push(block);
          together.set(k, e);
        }
    }
    for (const [k, e] of together) {
      if (e.n < 2) continue;
      const [a, b] = k.split("|");
      link(a, b, { kind: "bought together", detail: `bought in the same block ${e.n} times (blocks ${e.blocks.slice(0, 5).join(", ")})`, tx: e.tx, block: e.blocks[0] });
    }

    const holdersKnown = !!ctx.db.prepare("SELECT 1 FROM holder_progress WHERE token = ?").get(r.address);
    const held = ctx.db.prepare("SELECT balance FROM holders WHERE token = ? AND holder = ?");
    const groups = new Map<string, string[]>();
    for (const w of parent.keys()) groups.set(find(w), [...(groups.get(find(w)) ?? []), w]);
    const clusters = [...groups.values()]
      .filter((g) => g.length >= 2)
      .map((g) => {
        const members = g.map((wallet) => {
          const bal = holdersKnown ? BigInt((held.get(r.address, wallet) as { balance: string } | undefined)?.balance ?? "0") : null;
          return { wallet, isDeployer: wallet === r.deployer, balance: bal === null ? null : formatUnits(bal, 18), shareBps: bal === null ? null : bps(bal, supply), raw: bal ?? 0n };
        });
        const total = members.reduce((n, m) => n + m.raw, 0n);
        const mine = links.filter((l) => g.includes(l.a));
        return {
          wallets: g.length,
          holds: holdersKnown ? formatUnits(total, 18) : null,
          shareBps: holdersKnown ? bps(total, supply) : null,
          linkedBy: [...new Set(mine.map((l) => l.kind))],
          members: members.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0)).slice(0, 25).map(({ raw: _raw, ...m }) => m),
          evidence: mine.slice(0, 12).map((l) => ({ kind: l.kind, between: [l.a, l.b], detail: l.detail, tx: l.tx, block: l.block })),
          sort: total,
        };
      })
      .sort((a, b) => (b.sort > a.sort ? 1 : b.sort < a.sort ? -1 : b.wallets - a.wallets))
      .slice(0, Number(p.limit ?? 10))
      .map(({ sort: _sort, ...c }) => c);
    return {
      data: {
        token: r.address,
        symbol: r.symbol,
        clusters: clusters.length,
        walletsInClusters: clusters.reduce((n, c) => n + c.wallets, 0),
        list: clusters,
        method: `Two wallets are put in one cluster when the token was sent from one to the other, when both received it from the same wallet, or when they bought it in the same block at least twice. A sender with more than ${HUB} recipients is treated as a venue and links nobody.`,
        limits: "Funding is traced through transfers of this token only. Plain ETH sent between wallets is not in the index, so two wallets funded with ETH from one source are linked here only if they also traded together. A cluster is a pattern in the data, not proof that one person holds the wallets.",
        coverage: { ...coverage(ctx), transfers: sends.length, holders: holdersKnown },
      },
    };
  },
};

// ---------- wallets often early in tokens that then rose ----------

export const smartMoneySource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const within = Number(p.within ?? 60);
    const minEntries = Number(p.entries ?? 3);
    const RISE = 2n; // "rose" means the later price is at least this many times the wallet's own entry price
    const early = ctx.db
      .prepare(
        `SELECT t.trader, t.token, t.block, t.tx, t.time, t.quote, t.amount, t.quote_asset, k.launch_time, k.symbol, k.phase, k.deployer
         FROM trades t JOIN tokens k ON k.address = t.token
         WHERE k.launch_seen = 1 AND t.side = 'buy' AND t.time - k.launch_time <= ? ORDER BY t.block, t.log_index`,
      )
      .all(within) as (TradeRow & { launch_time: number; symbol: string; phase: number; deployer: string })[];
    // Each wallet's first early buy of each token.
    const first = new Map<string, (typeof early)[number]>();
    for (const t of early) if (isEth(t.quote_asset) && !first.has(`${t.trader}|${t.token}`)) first.set(`${t.trader}|${t.token}`, t);
    // Where each token trades now: the average of its last five trades, and how many trades it has had.
    const later = new Map<string, { px: bigint; trades: number; lastBlock: number; lastTx: string } | null>();
    const lastFive = ctx.db.prepare("SELECT quote, amount, quote_asset, block, tx FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 5");
    const nTrades = ctx.db.prepare("SELECT COUNT(*) n FROM trades WHERE token = ?");
    const laterOf = (token: string) => {
      if (later.has(token)) return later.get(token)!;
      const rows = (lastFive.all(token) as { quote: string; amount: string; quote_asset: string; block: number; tx: string }[]).filter((t) => isEth(t.quote_asset));
      const q = rows.reduce((n, t) => n + BigInt(t.quote), 0n);
      const a = rows.reduce((n, t) => n + BigInt(t.amount), 0n);
      const v = rows.length && a > 0n ? { px: (q * X18) / a, trades: (nTrades.get(token) as { n: number }).n, lastBlock: rows[0].block, lastTx: rows[0].tx } : null;
      later.set(token, v);
      return v;
    };
    const per = new Map<string, { token: string; symbol: string; t: (typeof early)[number]; entry: bigint; later: bigint; rose: boolean; graduated: boolean; own: boolean; lastBlock: number; lastTx: string }[]>();
    for (const t of first.values()) {
      const l = laterOf(t.token);
      const entry = pxOf(t);
      // A token with next to no trading after the entry has no "later" to speak of.
      if (!l || l.trades < 20 || entry === 0n || l.lastBlock <= t.block) continue;
      const row = { token: t.token, symbol: t.symbol, t, entry, later: l.px, rose: l.px >= entry * RISE, graduated: t.phase === 2, own: t.trader === t.deployer, lastBlock: l.lastBlock, lastTx: l.lastTx };
      per.set(t.trader, [...(per.get(t.trader) ?? []), row]);
    }
    const sellsOf = ctx.db.prepare("SELECT COALESCE(SUM(CAST(quote AS REAL)), 0) q FROM trades WHERE trader = ? AND token = ? AND side = 'sell'");
    const wallets = [...per.entries()]
      .map(([wallet, rows]) => ({ wallet, rows: rows.filter((r) => !r.own) }))
      .filter((w) => w.rows.length >= minEntries && w.rows.some((r) => r.rose))
      .map((w) => {
        const rose = w.rows.filter((r) => r.rose);
        return {
          wallet: w.wallet,
          earlyEntries: w.rows.length,
          rose: rose.length,
          roseShareBps: Math.round((rose.length / w.rows.length) * 10000),
          graduated: w.rows.filter((r) => r.graduated).length,
          spentOnEntries: eth(w.rows.reduce((n, r) => n + BigInt(r.t.quote), 0n)),
          soldAny: w.rows.filter((r) => (sellsOf.get(w.wallet, r.token) as { q: number }).q > 0).length,
          evidence: [...rose, ...w.rows.filter((r) => !r.rose)].slice(0, 8).map((r) => ({
            token: r.token,
            symbol: r.symbol,
            entry: { tx: r.t.tx, block: r.t.block, secondsAfterLaunch: Math.max(0, r.t.time - r.t.launch_time), price: eth(r.entry) },
            later: { price: eth(r.later), block: r.lastBlock, tx: r.lastTx, timesEntry: Number((r.later * 100n) / r.entry) / 100 },
            rose: r.rose,
            graduated: r.graduated,
          })),
        };
      })
      .sort((a, b) => b.rose - a.rose || b.roseShareBps - a.roseShareBps || b.earlyEntries - a.earlyEntries)
      .slice(0, Number(p.limit ?? 20));
    return {
      data: {
        count: wallets.length,
        wallets,
        method: `A wallet is listed when it bought at least ${minEntries} tokens within ${within} seconds of their launch and at least one of them rose. "Rose" means the token's price now (the average of its last five trades) is at least ${RISE} times what the wallet paid at entry, and the token has had 20 or more trades. A wallet's buys of tokens it deployed itself are left out.`,
        limits: "This is a record of where wallets were early, read from the indexed window only. It does not say why a wallet was early, whether it made money, or that it will be early again.",
        coverage: coverage(ctx),
      },
    };
  },
};
