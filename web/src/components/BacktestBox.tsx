"use client";
import { useState } from "react";
import { pct } from "@/lib/format";

interface Result { reads: string; pricesRead: number; from: string | null; to: string | null; trades: number; wins: number; winShare: number | null; pnlUsd: string; maxDrawdownUsd: string; note: string; lastTrades: { openedAt: string; closedAt: string; entry: string; exit: string; moveBps: number; pnlUsd: string; why: string }[] }

const L = ({ label, children }: { label: string; children: React.ReactNode }) => (<label className="stack" style={{ gap: 6 }}><span className="label">{label}</span>{children}</label>);

/** Build a small strategy and run it over the prices the engine has recorded. A real request, like any other feed. */
export function BacktestBox({ symbols }: { symbols: string[] }) {
  const [f, setF] = useState({ symbol: symbols.includes("ETH") ? "ETH" : (symbols[0] ?? "ETH"), direction: "down", bps: "50", windowMin: "60", side: "long", sizeUsd: "1000", holdMin: "120", takeBps: "", stopBps: "" });
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ""));
      const r = await fetch(`/api/v1/feeds/lab.backtest?${q}`, { cache: "no-store", headers: { "X-Specula-Client": "site" } });
      const j = await r.json();
      if (r.ok) setRes(j.data as Result);
      else {
        setRes(null);
        setErr(r.status === 402 ? "Today's free calls are used up. An agent would now pay for this one." : (j.message ?? "The engine could not run this."));
      }
    } catch {
      setErr("The request did not reach the site.");
    }
    setBusy(false);
  }
  return (
    <div className="stack" style={{ gap: 24 }}>
      <form className="panel" onSubmit={run}>
        <div className="panel-bar">Build a strategy</div>
        <div style={{ display: "grid", gap: 14, padding: 18, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <L label="Symbol"><select className="field" value={f.symbol} onChange={set("symbol")}>{symbols.map((s) => <option key={s}>{s}</option>)}</select></L>
          <L label="Enter when it"><select className="field" value={f.direction} onChange={set("direction")}><option value="down">falls</option><option value="up">rises</option></select></L>
          <L label="By (hundredths of a percent)"><input className="field" inputMode="numeric" value={f.bps} onChange={set("bps")} /></L>
          <L label="Within (minutes)"><input className="field" inputMode="numeric" value={f.windowMin} onChange={set("windowMin")} /></L>
          <L label="Then"><select className="field" value={f.side} onChange={set("side")}><option value="long">buy</option><option value="short">short</option></select></L>
          <L label="Size (dollars)"><input className="field" inputMode="numeric" value={f.sizeUsd} onChange={set("sizeUsd")} /></L>
          <L label="Close after (minutes)"><input className="field" inputMode="numeric" value={f.holdMin} onChange={set("holdMin")} /></L>
          <L label="Take profit at (optional)"><input className="field" inputMode="numeric" placeholder="none" value={f.takeBps} onChange={set("takeBps")} /></L>
          <L label="Stop loss at (optional)"><input className="field" inputMode="numeric" placeholder="none" value={f.stopBps} onChange={set("stopBps")} /></L>
        </div>
        <div className="runner-meta" style={{ justifyContent: "space-between", alignItems: "center", padding: 12 }}>
          <span>Runs over recorded prices. Nothing is bought.</span>
          <button className="btn sm" disabled={busy}>{busy ? "Running" : "Run the backtest"}</button>
        </div>
      </form>
      {err && <div className="empty"><b>No result</b>{err}</div>}
      {res && (
        <div className="stack" style={{ gap: 18 }}>
          <p className="answer" style={{ fontSize: "clamp(18px, 2.2vw, 22px)" }}>{res.reads}</p>
          <dl className="kv four">
            <div><dt>Trades</dt><dd>{res.trades}</dd></div>
            <div><dt>Won</dt><dd>{res.winShare === null ? "n/a" : pct(res.winShare, 0)}</dd></div>
            <div><dt>Profit and loss</dt><dd>{res.pnlUsd}<small>USD</small></dd></div>
            <div><dt>Worst drawdown</dt><dd>{res.maxDrawdownUsd}<small>USD</small></dd></div>
          </dl>
          {res.lastTrades.length > 0 && (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Opened</th><th>Closed</th><th className="num">Entry</th><th className="num">Exit</th><th className="num">Move</th><th className="num">Result</th><th>Closed by</th></tr></thead>
                <tbody>
                  {res.lastTrades.map((t) => (
                    <tr key={t.openedAt}><td className="id">{t.openedAt.slice(0, 16).replace("T", " ")}</td><td className="id">{t.closedAt.slice(0, 16).replace("T", " ")}</td><td className="num id">{t.entry}</td><td className="num id">{t.exit}</td><td className="num id">{(t.moveBps / 100).toFixed(2)}%</td><td className="num id">{t.pnlUsd}</td><td>{t.why}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small">{res.pricesRead.toLocaleString("en-US")} recorded prices{res.from ? `, from ${res.from.slice(0, 16).replace("T", " ")} to ${res.to!.slice(0, 16).replace("T", " ")} UTC` : ""}. {res.note}</p>
        </div>
      )}
    </div>
  );
}
