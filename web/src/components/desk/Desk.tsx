"use client";
// The live pieces shared by the homepage and the terminal: the status line, the launch list, the trade tape, the
// signal list and the price grid. All of it reads the live state in components/Live.tsx. Black, white and grey only:
// a side or a direction is shown by a word, a filled or outlined shape and an arrow, never by a colour.
import { useMemo, useState, type ReactNode } from "react";
import { ago, price, short, tiny } from "@/lib/format";
import { fireDetail } from "@/lib/signal";
import type { Fire, PriceCell, SiteData } from "@/lib/types";
import { useLive } from "../Live";

const age = (when: string | number, now: number) => ago(when, now).replace(" ago", "");
const num = (n: number) => n.toLocaleString("en-US");
/** A trade's size in dollars: cents under a hundred, whole dollars above. */
export const money = (v: string | number) => {
  const n = Number(v);
  return "$" + n.toLocaleString("en-US", n >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** The price board survives a poll where the engine could not read it: the last good board stays up. */
export function useBoard(site: SiteData | null) {
  const good = site?.prices?.points.length ? site.prices : null;
  const [last, setLast] = useState(good);
  if (good && good !== last) setLast(good);
  return good ?? last;
}

/** The ids that arrived after the first render, so only rows that are really new light up. */
function useArrived(ids: string[]): Set<string> {
  const [known, setKnown] = useState<Map<string, boolean>>(() => new Map(ids.map((id) => [id, false])));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    const next = new Map([...known].slice(-400));
    for (const id of missing) next.set(id, true);
    setKnown(next);
  }
  return useMemo(() => new Set([...known].filter(([, late]) => late).map(([id]) => id)), [known]);
}

/** Which way each price last moved: 1 up, -1 down. Nothing until a price has changed while the page is open. */
function useMoves(points: PriceCell[]): Map<string, 1 | -1> {
  const [state, setState] = useState<{ prices: Map<string, string>; moves: Map<string, 1 | -1> }>(() => ({ prices: new Map(points.map((p) => [p.symbol, p.price])), moves: new Map() }));
  const changed = points.filter((p) => state.prices.get(p.symbol) !== p.price);
  if (changed.length) {
    const prices = new Map(state.prices);
    const moves = new Map(state.moves);
    for (const p of changed) {
      const before = state.prices.get(p.symbol);
      if (before !== undefined) moves.set(p.symbol, Number(p.price) >= Number(before) ? 1 : -1);
      prices.set(p.symbol, p.price);
    }
    setState({ prices, moves });
  }
  return state.moves;
}

export function Panel({ title, meta, children, className = "", k }: { title: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; k?: string }) {
  return (
    <section className={`tm-p ${className}`} data-k={k}>
      <header className="tm-ph">
        <h3>{title}</h3>
        {meta ? <span className="tm-pm">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** A small arrow: up or down. The only thing that tells a rise from a fall besides the words. */
export const Arrow = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden>
    <path d={up ? "M5 1.5 9 8.5H1z" : "M5 8.5 1 1.5h8z"} />
  </svg>
);

const None = ({ children }: { children: ReactNode }) => <div className="tm-none">{children}</div>;

/** One line of chain facts across the top: the block the index is at and what it has read so far. */
export function StatusBar() {
  const { site, connected, now } = useLive();
  const ix = site?.index;
  const cells: [string, string][] = [];
  if (ix?.block) cells.push(["Block", num(ix.block)]);
  if (ix && ix.behindBlocks !== null) cells.push(["Index", ix.behindBlocks <= 3 ? "in step" : `${num(ix.behindBlocks)} behind`]);
  if (ix?.trades) cells.push(["Trades", num(ix.trades)]);
  if (ix?.tokens) cells.push(["Tokens", num(ix.tokens)]);
  if (ix?.pools) cells.push(["Pools", num(ix.pools)]);
  if (ix?.launches) cells.push(["Launches", num(ix.launches)]);
  return (
    <div className="tm-bar" role="status" aria-label="The chain index right now">
      <span className="tm-bar-live"><span className={`beacon${connected ? "" : " off"}`} /> Robinhood Chain</span>
      {cells.map(([k, v]) => (
        <span key={k}><i>{k}</i><b key={v} className="tm-tick">{v}</b></span>
      ))}
      {now > 0 && <span className="tm-bar-clock"><i>UTC</i><b suppressHydrationWarning>{new Date(now).toISOString().slice(11, 19)}</b></span>}
    </div>
  );
}

/** Launch fires carry the token's name, so a launch shows here the moment its signal fires, ahead of the next poll. */
function useLaunches(initial: Fire[]) {
  const { site, fires } = useLive();
  return useMemo(() => {
    const all = [...fires, ...initial];
    const sniped = new Map<string, number>();
    for (const f of all) if (f.rule === "sniped-launch" && typeof f.detail.token === "string") sniped.set(f.detail.token, Number(f.detail.buysInFirst10s) || 0);
    const rows = new Map<string, { token: string; symbol: string; name: string; at: string }>();
    for (const l of site?.launches ?? []) rows.set(l.token, { token: l.token, symbol: l.symbol, name: l.name, at: l.launchedAt });
    for (const f of all) {
      const t = f.detail.token;
      if (f.rule === "launch" && typeof t === "string" && !rows.has(t)) rows.set(t, { token: t, symbol: String(f.detail.symbol ?? f.subject), name: String(f.detail.name ?? ""), at: f.at });
    }
    return [...rows.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((r) => ({ ...r, sniped: sniped.get(r.token) ?? 0 }));
  }, [site?.launches, fires, initial]);
}

export function Launches({ fires, rows, onPick }: { fires: Fire[]; rows: number; onPick?: (token: string) => void }) {
  const { now } = useLive();
  const list = useLaunches(fires).slice(0, rows);
  const arrived = useArrived(list.map((l) => l.token));
  if (!list.length) return <None>No launch in the indexed window yet.</None>;
  return (
    <ul className="tm-list" style={{ ["--rows" as string]: rows }}>
      {list.map((l) => (
        <li key={l.token} className={`tm-r launch${arrived.has(l.token) ? " tm-new" : ""}${onPick ? " pick" : ""}`} onClick={onPick ? () => onPick(l.token) : undefined} title={onPick ? "Who sniped this launch" : undefined}>
          <b>{l.symbol}</b>
          <span className="tm-dim tm-clip">{l.name}</span>
          {l.sniped ? <span className="tm-tag fill" title={`${l.sniped} buys in the first 10 seconds`}>sniped</span> : <span />}
          <span className="tm-age" suppressHydrationWarning>{age(l.at, now)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Tape({ rows, wide = false, onPick }: { rows: number; wide?: boolean; onPick?: (token: string) => void }) {
  const { site, now } = useLive();
  // One transaction can hold two identical legs, so a trade is told apart by its transaction, amount and side, once.
  const list = useMemo(() => {
    const seen = new Set<string>();
    return (site?.trades ?? []).filter((t) => {
      const k = `${t.tx}${t.amount}${t.side}`;
      return seen.has(k) ? false : (seen.add(k), true);
    }).slice(0, rows);
  }, [site?.trades, rows]);
  const key = (t: (typeof list)[number]) => `${t.tx}${t.amount}${t.side}`;
  const arrived = useArrived(list.map(key));
  if (!list.length) return <None>No trade in the indexed window yet.</None>;
  return (
    <ul className="tm-list" style={{ ["--rows" as string]: rows }}>
      {list.map((t) => (
        <li key={key(t)} className={`tm-r trade${wide ? " wide" : ""}${arrived.has(key(t)) ? " tm-new" : ""}${onPick ? " pick" : ""}`} onClick={onPick ? () => onPick(t.token) : undefined} title={onPick ? "This token's time-weighted price" : undefined}>
          <span className="tm-age" suppressHydrationWarning>{age(t.time, now)}</span>
          <span className={`tm-side ${t.side}`}><Arrow up={t.side === "buy"} />{t.side === "buy" ? "Buy" : "Sell"}</span>
          <b className="tm-clip">{t.symbol || short(t.token)}</b>
          <span className="tm-num">{t.valueUsd ? money(t.valueUsd) : `${tiny(t.quote.amount)} ${t.quote.asset}`}</span>
          {wide && <span className="tm-dim tm-w">{short(t.trader, 6, 4)}</span>}
          <span className="tm-dim tm-venue">{t.venue}</span>
        </li>
      ))}
    </ul>
  );
}

const TAGS: Record<string, string> = { launch: "launch", "sniped-launch": "sniped", graduation: "grad", burn: "burn" };
const tag = (rule: string) => TAGS[rule] ?? rule.split("-")[0];

export function Fires({ fires: initial, rows, wide = false }: { fires: Fire[]; rows: number; wide?: boolean }) {
  const { fires: live, now } = useLive();
  const list = useMemo(() => [...live, ...initial.filter((f) => !live.some((l) => l.id === f.id))].slice(0, rows), [live, initial, rows]);
  const arrived = useArrived(list.map((f) => f.id));
  if (!list.length) return <None>No signal has fired yet. The rules are watching.</None>;
  return (
    <ul className="tm-list" style={{ ["--rows" as string]: rows }}>
      {list.map((f) => (
        <li key={f.id} className={`tm-r fire${wide ? " wide" : ""}${arrived.has(f.id) ? " tm-new" : ""}`} title={f.name}>
          <span className="tm-age" suppressHydrationWarning>{age(f.at, now)}</span>
          <span className={`tm-tag${f.rule.startsWith("whale") ? " fill" : ""}`}>{tag(f.rule)}</span>
          <b className="tm-clip">{f.subject.startsWith("0x") ? short(f.subject) : f.subject}</b>
          <span className="tm-dim tm-clip tm-right">{fireDetail(f.detail)}</span>
        </li>
      ))}
    </ul>
  );
}

const FIRST = ["NVDA", "AAPL", "MSFT", "TSLA", "AMZN", "GOOGL", "META", "AMD", "SPY", "QQQ", "PLTR", "COIN", "BTC", "ETH", "LINK"];
const rank = (s: string) => {
  const k = FIRST.indexOf(s);
  return k < 0 ? FIRST.length + (s.includes(".") || s.includes("/") ? 1 : 0) : k;
};
const KINDS: [string, string][] = [["all", "All"], ["equity", "Stocks"], ["crypto", "Crypto"], ["rate", "Rates"]];

/** Every on-chain price feed as one tight grid. A cell lights up when its feed posts a new round. */
export function Prices({ foot }: { foot?: ReactNode }) {
  const { site, hits, connected, now } = useLive();
  const board = useBoard(site);
  const [kind, setKind] = useState("all");
  const all = useMemo(() => [...(board?.points ?? [])].sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol)), [board]);
  const moves = useMoves(all);
  const kinds = KINDS.filter(([k]) => k === "all" || all.some((p) => p.kind === k));
  const cur = all.filter((p) => kind === "all" || p.kind === kind);
  return (
    <Panel
      className="tm-prices"
      title={<><span className={`beacon${connected ? "" : " off"}`} /> Price board</>}
      meta={
        kinds.length > 2 ? (
          <span className="tm-tabs" role="tablist" aria-label="Kind of price feed">
            {kinds.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                {label} <i>{k === "all" ? all.length : all.filter((p) => p.kind === k).length}</i>
              </button>
            ))}
          </span>
        ) : null
      }
    >
      {cur.length ? (
        <div className="tm-cells">
          {cur.map((p) => {
            const hit = now - (hits[p.symbol] ?? 0) < 2400;
            const move = moves.get(p.symbol);
            return (
              <div key={p.symbol} className={`tm-cell${hit ? " hit" : ""}${move === 1 ? " up" : move === -1 ? " dn" : ""}`}>
                <b className="tm-clip">{p.symbol}</b>
                <span className="tm-num" key={p.price} title={move === 1 ? "up since the page opened" : move === -1 ? "down since the page opened" : undefined}>{move ? <Arrow up={move === 1} /> : null}{price(p.price, p.quote)}</span>
                <span className="tm-age" suppressHydrationWarning>{p.resting ? "closed" : age(p.updatedAtSec, now)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <None>The board fills in when the engine finishes its first reading.</None>
      )}
      {board && (
        <footer className="tm-pf">
          <span><b>{board.points.length}</b> on-chain price feeds, read from {board.source} <span suppressHydrationWarning>{ago(board.collectedAt, now)}</span></span>
          {foot}
        </footer>
      )}
    </Panel>
  );
}
