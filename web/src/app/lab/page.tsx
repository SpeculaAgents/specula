import type { Metadata } from "next";
import { BacktestBox } from "@/components/BacktestBox";
import { Boundary } from "@/components/Boundary";
import { Code } from "@/components/Code";
import { Offline, PageHead } from "@/components/PageHead";
import { Reveal } from "@/components/Reveal";
import { getArchive, getLab, getSite } from "@/lib/engine";
import { int, utc } from "@/lib/format";

export const metadata: Metadata = { title: "Strategy lab", description: "Test a strategy on the prices Specula has recorded, run it on live prices without money, and replay any feed as it was." };

export default async function Lab() {
  const [lab, archive, site] = await Promise.all([getLab(), getArchive(), getSite()]);
  const symbols = (site?.prices?.points ?? []).filter((p) => p.kind !== "rate").map((p) => p.symbol).sort();
  return (
    <>
      <PageHead crumb="Lab" title="Test before it trades">
        Run a strategy over the prices the engine has recorded, then let it follow live prices with pretend money. The archive behind it keeps every feed as it was, signature included.
      </PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 72 }}>
          {!lab ? <Offline what="the lab" /> : (
            <>
              <dl className="kv four">
                <div><dt>Prices recorded</dt><dd>{int(lab.pricesRecorded)}</dd></div>
                <div><dt>Symbols</dt><dd>{int(lab.symbols)}</dd></div>
                <div><dt>Answers in the archive</dt><dd>{int(archive?.answers ?? 0)}</dd></div>
                <div><dt>Paper runs live</dt><dd>{int(lab.paperRuns)}</dd></div>
              </dl>
              <div className="stack">
                <div className="mark">Backtest</div>
                <Boundary>{symbols.length ? <BacktestBox symbols={symbols} /> : <div className="empty"><b>No prices yet</b>The form appears when the engine has read the price feeds.</div>}</Boundary>
                <p className="small">History starts {lab.since ? utc(lab.since) : "when the engine first runs"} and grows from there. A backtest has no fees, no slippage and instant fills.</p>
              </div>
              <div className="grid2" style={{ alignItems: "start" }}>
                <Reveal className="stack">
                  <div className="mark">Paper run</div>
                  <p className="body">The same rule, on live prices, with pretend money. The engine steps your run on every new price and keeps its trades. Start one with the SDK from your agent&apos;s wallet.</p>
                  <Code>{`const run = await specula.startPaperRun({
  symbol: "NVDA", direction: "down", bps: 150, windowMin: 60,
  side: "long", sizeUsd: 1000, holdMin: 240, stopBps: 200,
});
console.log(await specula.paperRuns()); // trades and profit so far`}</Code>
                </Reveal>
                <Reveal delay={1} className="stack">
                  <div className="mark">Archive and replay</div>
                  <p className="body">Ask what any feed said at a past moment, or replay a stretch of time. Each archived answer carries its original signature, so it checks out like a live one.</p>
                  <Code>{`const then = await specula.asOf("chain.prices", { kind: "all" }, "2026-11-16T21:00:00Z");
const day = await specula.replay("macro.snapshot", {}, { limit: 24 });`}</Code>
                </Reveal>
              </div>
              <div className="stack">
                <div className="mark">What the archive holds</div>
                {archive && archive.feeds.length ? (
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>Feed</th><th className="num">Answers kept</th><th className="num">Series</th><th>From</th><th>To</th></tr></thead>
                      <tbody>
                        {archive.feeds.slice(0, 14).map((f) => (
                          <tr key={f.feed}><td className="id"><a className="link" href={`/feeds/${f.feed}`}>{f.feed}</a></td><td className="num id">{int(f.answers)}</td><td className="num id">{int(f.series)}</td><td className="id muted">{utc(f.from)}</td><td className="id muted">{utc(f.to)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty"><b>Nothing archived yet</b>The archive fills as feeds are asked for.</div>}
                {archive && <p className="small">Answers are kept for {archive.keepsDays} days, at most one per feed every few minutes.</p>}
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
