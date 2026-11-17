import { formatUnits, type Address } from "viem";
import type { Ctx } from "../ctx.ts";
import type { Source } from "../collect.ts";
import { bps, HttpError, iso, lower, nowSec, ZERO } from "../util.ts";
import { ADDR, erc20Abi, factoryAbi, phaseName } from "./abi.ts";
import { catchUpHolders, cleanName, findLaunch, indexHead, type TradeRow } from "./indexer.ts";
import { ethUsd } from "./prices.ts";

interface Asset {
  symbol: string | null;
  name: string | null;
  decimals: number;
}
const assetOf = (ctx: Ctx, a: string): Asset => (ctx.db.prepare("SELECT symbol, name, decimals FROM assets WHERE address = ?").get(a) as Asset | undefined) ?? { symbol: a === ZERO ? "ETH" : null, name: null, decimals: 18 };

/** Price of one whole base token in the quote asset, as a decimal string. Integer math only. */
export function priceOf(quote: bigint, amount: bigint, baseDecimals: number, quoteDecimals: number): string | null {
  if (amount === 0n) return null;
  const scaled = (quote * 10n ** BigInt(baseDecimals) * 10n ** 18n) / amount; // quote base units per whole token, 18 extra places
  return formatUnits(scaled, quoteDecimals + 18);
}

/** USD value (2 decimals, rounded down) of an amount of ETH or of a dollar token. Null when it cannot be priced. */
export function usdOf(ctx: Ctx, quoteAsset: string, quote: bigint): string | null {
  if (quoteAsset === lower(ADDR.usdg)) return formatUnits(quote / 10_000n, 2);
  if (quoteAsset !== ZERO && quoteAsset !== lower(ADDR.weth)) return null;
  const px = ethUsd(ctx);
  if (px === null) return null;
  return formatUnits((quote * px) / 10n ** 24n, 2); // wei * 1e8 price / 1e24 = cents
}

export function shapeTrade(ctx: Ctx, t: TradeRow) {
  const base = assetOf(ctx, t.token);
  const q = assetOf(ctx, t.quote_asset);
  return {
    token: t.token,
    symbol: base.symbol,
    side: t.side,
    trader: t.trader,
    amount: formatUnits(BigInt(t.amount), base.decimals),
    quote: { asset: q.symbol ?? t.quote_asset, amount: formatUnits(BigInt(t.quote), q.decimals) },
    price: priceOf(BigInt(t.quote), BigInt(t.amount), base.decimals, q.decimals),
    valueUsd: usdOf(ctx, t.quote_asset, BigInt(t.quote)),
    venue: t.venue,
    block: t.block,
    tx: t.tx,
    time: iso(t.time),
  };
}

const coverage = (ctx: Ctx) => {
  const start = ctx.db.prepare("SELECT value FROM kv WHERE key = 'index_start'").get() as { value: string } | undefined;
  const head = indexHead(ctx);
  const first = ctx.db.prepare("SELECT MIN(time) t FROM trades").get() as { t: number | null };
  return { fromBlock: start ? Number(start.value) : null, toBlock: head === null ? null : Number(head), since: first.t ? iso(first.t) : null };
};

const needIndex = (ctx: Ctx) => {
  // Not a source failure: the engine has only just started and is reading its first blocks.
  if (indexHead(ctx) === null) throw new HttpError(409, "indexing", "The chain index is reading its first blocks. Ask again in a minute. You were not charged.", { retryAfter: 30 });
};

interface TokenRow {
  address: string;
  curve: string | null;
  name: string;
  symbol: string;
  deployer: string;
  launch_block: number;
  launch_time: number;
  launch_seen: number;
  tax_bps: number | null;
  phase: number;
  pool_id: string | null;
  graduated_at: number | null;
  supply: string | null;
}

function tokenStats(ctx: Ctx, token: string, since: number) {
  const rows = ctx.db.prepare("SELECT side, quote, quote_asset, trader FROM trades WHERE token = ? AND time >= ?").all(token, since) as { side: string; quote: string; quote_asset: string; trader: string }[];
  let vol = 0n;
  let buys = 0;
  let sells = 0;
  const traders = new Set<string>();
  let asset = ZERO as string;
  for (const r of rows) {
    vol += BigInt(r.quote);
    asset = r.quote_asset;
    if (r.side === "buy") buys++;
    else sells++;
    traders.add(r.trader);
  }
  return { vol, buys, sells, traders: traders.size, asset };
}

function shapeToken(ctx: Ctx, r: TokenRow) {
  const last = ctx.db.prepare("SELECT * FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 1").get(r.address) as TradeRow | undefined;
  const day = tokenStats(ctx, r.address, nowSec() - 86400);
  const q = assetOf(ctx, day.asset);
  const price = last ? priceOf(BigInt(last.quote), BigInt(last.amount), 18, assetOf(ctx, last.quote_asset).decimals) : null;
  let marketCapUsd: string | null = null;
  if (last && r.supply) {
    const capQuote = (BigInt(last.quote) * BigInt(r.supply)) / BigInt(last.amount);
    marketCapUsd = usdOf(ctx, last.quote_asset, capQuote);
  }
  return {
    token: r.address,
    name: r.name,
    symbol: r.symbol,
    deployer: r.deployer,
    curve: r.curve,
    phase: phaseName(r.phase),
    poolId: r.pool_id,
    launchedAt: r.launch_seen ? iso(r.launch_time) : null,
    firstSeenAt: iso(r.launch_time),
    graduatedAt: r.graduated_at ? iso(r.graduated_at) : null,
    supply: r.supply ? formatUnits(BigInt(r.supply), 18) : null,
    price,
    priceAsset: last ? assetOf(ctx, last.quote_asset).symbol : null,
    marketCapUsd,
    lastTradeAt: last ? iso(last.time) : null,
    day: { volume: formatUnits(day.vol, q.decimals), volumeAsset: q.symbol, volumeUsd: usdOf(ctx, day.asset, day.vol), buys: day.buys, sells: day.sells, traders: day.traders },
  };
}

export const tradesSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const limit = Number(p.limit ?? 50);
    const rows = (p.token
      ? ctx.db.prepare("SELECT * FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT ?").all(p.token, limit)
      : ctx.db.prepare("SELECT * FROM trades ORDER BY block DESC, log_index DESC LIMIT ?").all(limit)) as TradeRow[];
    return { data: { count: rows.length, coverage: coverage(ctx), trades: rows.map((t) => shapeTrade(ctx, t)) } };
  },
};

export const launchesSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const rows = ctx.db.prepare("SELECT * FROM tokens WHERE launch_seen = 1 ORDER BY launch_block DESC LIMIT ?").all(Number(p.limit ?? 20)) as TokenRow[];
    const first = ctx.db.prepare("SELECT * FROM trades WHERE token = ? AND side = 'buy' ORDER BY block, log_index LIMIT ?");
    const n = Number(p.buyers ?? 5);
    return {
      data: {
        count: rows.length,
        coverage: coverage(ctx),
        launches: rows.map((r) => ({
          ...shapeToken(ctx, r),
          firstBuyers: (first.all(r.address, n) as TradeRow[]).map((t) => ({ trader: t.trader, quote: formatUnits(BigInt(t.quote), 18), amount: formatUnits(BigInt(t.amount), 18), secondsAfterLaunch: Math.max(0, t.time - r.launch_time), tx: t.tx })),
        })),
      },
    };
  },
};

async function knownToken(ctx: Ctx, token: string): Promise<TokenRow> {
  const row = ctx.db.prepare("SELECT * FROM tokens WHERE address = ?").get(token) as TokenRow | undefined;
  if (row) return row;
  // Not seen in the window: ask the launch factory whether it knows the token at all.
  const info = (await ctx.pub.readContract({ address: ADDR.ponsFactory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token as Address] })) as { exists: boolean; curve: Address; deployer: Address; creatorTaxBps: number; phase: number };
  if (!info.exists) throw new HttpError(404, "unknown_token", "This address is not a token launched on the chain's launch factory.");
  const [name, symbol, supply] = await ctx.pub.multicall({
    contracts: [
      { address: token as Address, abi: erc20Abi, functionName: "name" },
      { address: token as Address, abi: erc20Abi, functionName: "symbol" },
      { address: token as Address, abi: erc20Abi, functionName: "totalSupply" },
    ],
    allowFailure: true,
  });
  const head = indexHead(ctx) ?? 0n;
  ctx.db
    .prepare("INSERT OR IGNORE INTO tokens (address, curve, name, symbol, deployer, launch_block, launch_time, launch_seen, tax_bps, phase, supply) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .run(token, lower(info.curve), name.status === "success" ? cleanName(name.result) : "", symbol.status === "success" ? cleanName(symbol.result, 16) : "", lower(info.deployer), Number(head), nowSec(), info.creatorTaxBps, info.phase, supply.status === "success" ? String(supply.result) : null);
  ctx.db.prepare("INSERT OR IGNORE INTO assets (address, symbol, name, decimals) VALUES (?, ?, ?, 18)").run(token, symbol.status === "success" ? cleanName(symbol.result, 16) : null, name.status === "success" ? cleanName(name.result) : null);
  return ctx.db.prepare("SELECT * FROM tokens WHERE address = ?").get(token) as TokenRow;
}

export const tokenSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const r = await knownToken(ctx, p.token);
    return { data: { ...shapeToken(ctx, r), coverage: coverage(ctx) } };
  },
};

const jobs = new WeakMap<Ctx, Map<string, Promise<void>>>();
/** Holders of a token outside the window need its whole transfer history first. That runs once, in the background. */
function startHolderJob(ctx: Ctx, r: TokenRow) {
  let m = jobs.get(ctx);
  if (!m) jobs.set(ctx, (m = new Map()));
  if (m.has(r.address)) return;
  const job = (async () => {
    const head = indexHead(ctx)!;
    if (!ctx.db.prepare("SELECT 1 FROM holder_progress WHERE token = ?").get(r.address)) {
      const block = r.launch_seen ? BigInt(r.launch_block) : await findLaunch(ctx, r.address as Address, head);
      if (block === null) return;
      ctx.db.prepare("INSERT OR IGNORE INTO holder_progress (token, from_block, last_block) VALUES (?, ?, ?)").run(r.address, Number(block), Number(block) - 1);
    }
    await catchUpHolders(ctx, r.address, head);
  })()
    .catch(() => {})
    .finally(() => m!.delete(r.address));
  m.set(r.address, job);
}

export const holdersSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const r = await knownToken(ctx, p.token);
    const head = indexHead(ctx)!;
    const prog = ctx.db.prepare("SELECT * FROM holder_progress WHERE token = ?").get(r.address) as { from_block: number; last_block: number; transfers: number; burned: string } | undefined;
    if (!prog || BigInt(prog.last_block) + 200_000n < head) {
      startHolderJob(ctx, r);
      throw new HttpError(409, "indexing", "Reading this token's transfer history from the chain. Ask again in a minute. You were not charged.", { retryAfter: 60 });
    }
    if (BigInt(prog.last_block) < head) await catchUpHolders(ctx, r.address, head);
    const rows = ctx.db.prepare("SELECT holder, balance FROM holders WHERE token = ?").all(r.address) as { holder: string; balance: string }[];
    const venue = new Map<string, string>([[lower(ADDR.poolManager), "pool"]]);
    if (r.curve) venue.set(r.curve, "curve");
    const all = rows.map((h) => ({ holder: h.holder, balance: BigInt(h.balance) })).sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0));
    const wallets = all.filter((h) => !venue.has(h.holder));
    const held = wallets.reduce((n, h) => n + h.balance, 0n);
    const supply = BigInt(r.supply ?? "0") || all.reduce((n, h) => n + h.balance, 0n);
    const top = (k: number) => bps(wallets.slice(0, k).reduce((n, h) => n + h.balance, 0n), supply);
    // Herfindahl index over wallet shares of supply, 0 to 10000.
    const hhi = Number(wallets.reduce((n, h) => n + ((h.balance * 10000n) / (supply || 1n)) ** 2n, 0n) / 10000n);
    const limit = Number(p.limit ?? 20);
    return {
      data: {
        token: r.address,
        symbol: r.symbol,
        holders: wallets.length,
        supply: formatUnits(supply, 18),
        heldByWallets: formatUnits(held, 18),
        inVenues: all.filter((h) => venue.has(h.holder)).map((h) => ({ venue: venue.get(h.holder), address: h.holder, balance: formatUnits(h.balance, 18), shareBps: bps(h.balance, supply) })),
        burned: formatUnits(BigInt(prog.burned), 18),
        concentration: { top1Bps: top(1), top10Bps: top(10), top50Bps: top(50), hhi },
        top: wallets.slice(0, limit).map((h, i) => ({ rank: i + 1, holder: h.holder, balance: formatUnits(h.balance, 18), shareBps: bps(h.balance, supply), isDeployer: h.holder === r.deployer })),
        readFromBlock: prog.from_block,
        readToBlock: Number(head),
        transfersRead: prog.transfers,
      },
    };
  },
};

export const liquiditySource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    let poolId: string | null = p.pool ?? null;
    if (p.token) {
      const r = ctx.db.prepare("SELECT pool_id FROM tokens WHERE address = ?").get(p.token) as { pool_id: string | null } | undefined;
      poolId = r?.pool_id ?? (ctx.db.prepare("SELECT id FROM pools WHERE currency0 = ? OR currency1 = ? LIMIT 1").get(p.token, p.token) as { id: string } | undefined)?.id ?? null;
      if (!poolId) throw new HttpError(404, "no_pool", "No pool is known for this token inside the indexed window.");
    }
    const limit = Number(p.limit ?? 50);
    const rows = (poolId
      ? ctx.db.prepare("SELECT * FROM liquidity WHERE pool_id = ? ORDER BY block DESC, log_index DESC LIMIT ?").all(lower(poolId), limit)
      : ctx.db.prepare("SELECT * FROM liquidity ORDER BY block DESC, log_index DESC LIMIT ?").all(limit)) as { pool_id: string; block: number; tx: string; time: number; sender: string; tick_lower: number; tick_upper: number; delta: string }[];
    const pool = ctx.db.prepare("SELECT * FROM pools WHERE id = ?");
    return {
      data: {
        count: rows.length,
        coverage: coverage(ctx),
        events: rows.map((l) => {
          const pl = pool.get(l.pool_id) as { currency0: string; currency1: string; fee: number; kind: string } | undefined;
          return {
            pool: l.pool_id,
            pair: pl ? `${assetOf(ctx, pl.currency0).symbol ?? pl.currency0}/${assetOf(ctx, pl.currency1).symbol ?? pl.currency1}` : null,
            kind: BigInt(l.delta) >= 0n ? "add" : "remove",
            liquidityDelta: l.delta,
            tickLower: l.tick_lower,
            tickUpper: l.tick_upper,
            sender: l.sender,
            block: l.block,
            tx: l.tx,
            time: iso(l.time),
          };
        }),
      },
    };
  },
};

export const walletSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const a = p.address;
    const rows = ctx.db.prepare("SELECT * FROM trades WHERE trader = ? ORDER BY block DESC, log_index DESC").all(a) as TradeRow[];
    let spent = 0n;
    let got = 0n;
    const per = new Map<string, { buys: number; sells: number; spent: bigint; got: bigint; last: number }>();
    for (const t of rows) {
      if (t.quote_asset !== ZERO && t.quote_asset !== lower(ADDR.weth)) continue;
      const e = per.get(t.token) ?? { buys: 0, sells: 0, spent: 0n, got: 0n, last: 0 };
      if (t.side === "buy") {
        spent += BigInt(t.quote);
        e.buys++;
        e.spent += BigInt(t.quote);
      } else {
        got += BigInt(t.quote);
        e.sells++;
        e.got += BigInt(t.quote);
      }
      e.last = Math.max(e.last, t.time);
      per.set(t.token, e);
    }
    const [eth, usdg] = await Promise.all([
      ctx.pub.getBalance({ address: a as Address }).catch(() => null),
      ctx.pub.readContract({ address: ADDR.usdg, abi: erc20Abi, functionName: "balanceOf", args: [a as Address] }).catch(() => null),
    ]);
    const launches = ctx.db.prepare("SELECT address, symbol, launch_time FROM tokens WHERE deployer = ? AND launch_seen = 1 ORDER BY launch_block DESC LIMIT 20").all(a) as { address: string; symbol: string; launch_time: number }[];
    const fastBuys = (ctx.db.prepare("SELECT COUNT(*) n FROM trades t JOIN tokens k ON k.address = t.token WHERE t.trader = ? AND t.side = 'buy' AND k.launch_seen = 1 AND t.time - k.launch_time <= 10").get(a) as { n: number }).n;
    const net = got - spent;
    return {
      data: {
        address: a,
        balances: { eth: eth === null ? null : formatUnits(eth, 18), usdg: usdg === null ? null : formatUnits(usdg as bigint, 6) },
        coverage: coverage(ctx),
        trades: rows.length,
        firstSeenAt: rows.length ? iso(rows[rows.length - 1].time) : null,
        lastSeenAt: rows.length ? iso(rows[0].time) : null,
        ethSpent: formatUnits(spent, 18),
        ethReceived: formatUnits(got, 18),
        netEth: `${net < 0n ? "-" : ""}${formatUnits(net < 0n ? -net : net, 18)}`,
        tokensTraded: per.size,
        buysWithin10sOfLaunch: fastBuys,
        launches: launches.map((l) => ({ token: l.address, symbol: l.symbol, launchedAt: iso(l.launch_time) })),
        tokens: [...per.entries()]
          .sort((x, y) => y[1].last - x[1].last)
          .slice(0, 25)
          .map(([token, e]) => ({ token, symbol: assetOf(ctx, token).symbol, buys: e.buys, sells: e.sells, ethSpent: formatUnits(e.spent, 18), ethReceived: formatUnits(e.got, 18), lastTradeAt: iso(e.last) })),
      },
    };
  },
};

export const feesSource: Source = {
  id: "index",
  async run(ctx, p) {
    needIndex(ctx);
    const r = await knownToken(ctx, p.token);
    const rows = ctx.db.prepare("SELECT fee, tax, quote, time FROM trades WHERE token = ? AND venue = 'curve'").all(r.address) as { fee: string; tax: string; quote: string; time: number }[];
    const day = nowSec() - 86400;
    let fee = 0n;
    let tax = 0n;
    let vol = 0n;
    let fee24 = 0n;
    let tax24 = 0n;
    for (const t of rows) {
      fee += BigInt(t.fee);
      tax += BigInt(t.tax);
      vol += BigInt(t.quote);
      if (t.time >= day) {
        fee24 += BigInt(t.fee);
        tax24 += BigInt(t.tax);
      }
    }
    const burns = ctx.db.prepare("SELECT * FROM burns WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 25").all(r.address) as { tx: string; time: number; sender: string; amount: string; block: number }[];
    const prog = ctx.db.prepare("SELECT burned, last_block FROM holder_progress WHERE token = ?").get(r.address) as { burned: string; last_block: number } | undefined;
    return {
      data: {
        token: r.address,
        symbol: r.symbol,
        coverage: coverage(ctx),
        creatorTaxBps: r.tax_bps,
        curve: {
          trades: rows.length,
          volumeEth: formatUnits(vol, 18),
          tradingFeesEth: formatUnits(fee, 18),
          creatorTaxEth: formatUnits(tax, 18),
          tradingFees24hEth: formatUnits(fee24, 18),
          creatorTax24hEth: formatUnits(tax24, 18),
          feesUsd: usdOf(ctx, ZERO, fee + tax),
        },
        pool: { measured: false, note: "Fees taken inside the pool phase are not in the trade events and are not estimated here." },
        burns: {
          tracked: !!prog,
          total: prog ? formatUnits(BigInt(prog.burned), 18) : null,
          shareOfSupplyBps: prog && r.supply ? bps(BigInt(prog.burned), BigInt(r.supply)) : null,
          recent: burns.map((b) => ({ amount: formatUnits(BigInt(b.amount), 18), sender: b.sender, block: b.block, tx: b.tx, time: iso(b.time) })),
        },
      },
    };
  },
};

/** Counts for the status page and the site: how much of the chain the index holds. */
export function indexStats(ctx: Ctx) {
  const n = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;
  const head = indexHead(ctx);
  const chainHead = ctx.db.prepare("SELECT value FROM kv WHERE key = 'index_head'").get() as { value: string } | undefined;
  const at = ctx.db.prepare("SELECT value FROM kv WHERE key = 'index_at'").get() as { value: string } | undefined;
  return {
    block: head === null ? null : Number(head),
    behindBlocks: head !== null && chainHead ? Math.max(0, Number(chainHead.value) - Number(head)) : null,
    lastTickAt: at ? iso(Number(at.value)) : null,
    tokens: n("SELECT COUNT(*) n FROM tokens"),
    launches: n("SELECT COUNT(*) n FROM tokens WHERE launch_seen = 1"),
    trades: n("SELECT COUNT(*) n FROM trades"),
    pools: n("SELECT COUNT(*) n FROM pools"),
    liquidityEvents: n("SELECT COUNT(*) n FROM liquidity"),
    holdersTracked: n("SELECT COUNT(*) n FROM holder_progress"),
    burns: n("SELECT COUNT(*) n FROM burns"),
    ...coverage(ctx),
  };
}
