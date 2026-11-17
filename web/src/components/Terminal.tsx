"use client";
import { useState } from "react";
import { ago } from "@/lib/format";
import type { FeedEntry, Fire } from "@/lib/types";
import { usageShown } from "@/lib/usage";
import { Answer } from "./answer/Answer";
import { Fires, Launches, Panel, Prices, Tape } from "./desk/Desk";
import { useLive } from "./Live";

const HELP = `Type a feed and its parameters, or a question.

  launches                   new token launches
  trades                     DEX trades
  snipers 0x...              who bought a launch in its first blocks
  deployer 0x...             what a wallet launched before, and what became of it
  clusters 0x...             holders of a token that move together
  smartmoney                 wallets often early in tokens that then rose
  twap 0x...                 a token's time-weighted price, or "thin market"
  price NVDA                 one price
  events TSLA                a company's 8-K events
  insiders NVDA              insider trades
  fundamentals AAPL          reported numbers
  economy                    the economy snapshot
  chain.holders token=0x...  any feed by id, with key=value
  what is ETH trading at?    a question in plain words`;

/** Turn a typed line into a request path. Short names map to feeds; anything else is asked as a question. */
export function toPath(line: string, feeds: FeedEntry[]): string {
  const t = line.trim();
  const [head, ...rest] = t.split(/\s+/);
  const short: Record<string, [string, string | null]> = { price: ["chain.price", "symbol"], prices: ["chain.prices", null], trades: ["chain.trades", null], launches: ["chain.launches", null], snipers: ["chain.snipers", "token"], deployer: ["chain.deployer", "address"], clusters: ["chain.clusters", "token"], smartmoney: ["chain.smartmoney", null], twap: ["chain.twap", "token"], token: ["chain.token", "token"], holders: ["chain.holders", "token"], wallet: ["chain.wallet", "address"], fees: ["chain.fees", "token"], filings: ["sec.filings", "ticker"], events: ["sec.events", "ticker"], insiders: ["sec.insiders", "ticker"], holdings: ["sec.holdings", "manager"], fundamentals: ["sec.fundamentals", "ticker"], summary: ["sec.summary", "ticker"], economy: ["macro.snapshot", null], series: ["macro.series", "series"], signals: ["signals.recent", null], record: ["signals.record", null], briefing: ["answers.briefing", null], index: ["index.value", "index"] };
  const m = short[head.toLowerCase()];
  const byId = feeds.find((f) => f.id === head.toLowerCase());
  if (m || byId) {
    const id = m ? m[0] : byId!.id;
    const q = new URLSearchParams();
    const first = m ? m[1] : (byId!.params.find((p) => p.required)?.name ?? null);
    for (const tok of rest) {
      const eq = tok.indexOf("=");
      if (eq > 0) q.set(tok.slice(0, eq), tok.slice(eq + 1));
      else if (first && !q.has(first)) q.set(first, tok);
    }
    const s = q.toString();
    return `/v1/feeds/${id}${s ? `?${s}` : ""}`;
  }
  return `/v1/feeds/answers.ask?${new URLSearchParams({ q: t })}`;
}

const TRY = ["launches", "smartmoney", "price NVDA", "insiders NVDA", "economy"];

export function Terminal({ feeds, fires, rules }: { feeds: FeedEntry[]; fires: Fire[]; rules: number }) {
  const { site, now } = useLive();
  const [line, setLine] = useState("");
  const [out, setOut] = useState<{ cmd: string; path: string; status: number; ms: number; body: unknown; help?: boolean; cost: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const usage = usageShown(site?.stats);
  const ix = site?.index;

  async function ask(cmd: string) {
    if (!cmd) return;
    if (cmd === "help" || cmd === "?") return setOut({ cmd, path: "", status: 200, ms: 0, body: HELP, help: true, cost: "" });
    const path = toPath(cmd, feeds);
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await fetch(`/api${path}`, { cache: "no-store", headers: { "X-Specula-Client": "terminal" } });
      const j = (await r.json()) as { meta?: { paidBy: string; price: { amount: string } } };
      setOut({ cmd, path, status: r.status, ms: Math.round(performance.now() - t0), body: j, cost: j.meta ? (j.meta.paidBy === "free" ? "free allowance" : `${j.meta.price.amount} USDG`) : "" });
    } catch {
      setOut({ cmd, path, status: 0, ms: 0, body: { error: "network", message: "The request did not reach the site." }, cost: "" });
    }
    setBusy(false);
    setLine("");
  }
  /** A row on the board asks about itself: a launch for its snipers, a trade for the token's time-weighted price. */
  const pick = (cmd: string) => {
    void ask(cmd);
    document.querySelector(".tt-cmd")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <div className={`tm-grid tt${usage ? " with-usage" : ""}`}>
      <Panel className="tt-cmd" title="Command line" meta="Type help, or click a launch or a trade">
        <form className="tt-form" onSubmit={(e) => { e.preventDefault(); void ask(line.trim()); }}>
          <span aria-hidden>&gt;</span>
          <input value={line} onChange={(e) => setLine(e.target.value)} placeholder={busy ? "asking the engine" : "launches, price NVDA, events TSLA, or a question"} aria-label="Command" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy} />
          <button className="btn sm" disabled={busy}>Run</button>
        </form>
        {out ? (
          <>
            <div className="tt-meta">
              <span><b>{out.cmd}</b></span>
              {out.path && <code className="tm-clip">{out.path.length > 60 ? `${out.path.slice(0, 60)}...` : out.path}</code>}
              {out.path && <span>status <b>{out.status}</b></span>}
              {out.path && <span><b>{out.ms} ms</b></span>}
              {out.cost && <span>paid by <b>{out.cost}</b></span>}
            </div>
            <div className="tt-ans">{out.help ? <pre className="av-say" tabIndex={0}>{String(out.body)}</pre> : <Answer body={out.body} />}</div>
          </>
        ) : (
          <div className="tt-try">
            <span>Try</span>
            {TRY.map((c) => (
              <button key={c} className="chip" onClick={() => void ask(c)} disabled={busy}>{c}</button>
            ))}
          </div>
        )}
      </Panel>
      <Panel className="tt-launches" title="New launches" meta={ix?.launches ? <><b>{ix.launches.toLocaleString("en-US")}</b> seen</> : null}>
        <Launches fires={fires} rows={12} onPick={(token) => pick(`snipers ${token}`)} />
      </Panel>
      <Panel className="tt-signals" title="Signals" meta={rules ? <><b>{rules}</b> rules watching</> : null}>
        <Fires fires={fires} rows={12} />
      </Panel>
      <Panel className="tt-trades" title="DEX trades" meta={ix?.trades ? <><b>{ix.trades.toLocaleString("en-US")}</b> indexed</> : null}>
        <Tape rows={12} onPick={(token) => pick(`twap ${token}`)} />
      </Panel>
      {usage && site ? (
        <Panel className="tt-reqs" title="Requests" meta={<><b>{site.stats.requests24h.toLocaleString("en-US")}</b> in 24 h</>}>
          <ul className="tm-list" style={{ ["--rows" as string]: 12 }}>
            {site.requests.slice(0, 12).map((r) => (
              <li key={r.id} className="tm-r req">
                <span className="tm-age" suppressHydrationWarning>{ago(r.at, now).replace(" ago", "")}</span>
                <b className="tm-clip">{r.feed}</b>
                <span className="tm-num">{r.paidBy === "free" ? "free" : r.price}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Prices />
    </div>
  );
}
