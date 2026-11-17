import type { Metadata } from "next";
import { Code } from "@/components/Code";
import { Offline, PageHead } from "@/components/PageHead";
import { getIndexes } from "@/lib/engine";
import { bps, utc } from "@/lib/format";

export const metadata: Metadata = { title: "Indexes", description: "Specula's own indexes, computed from on-chain price feeds, and the signed reports a smart contract can read." };

function Spark({ points }: { points: { t: number; v: number }[] }) {
  if (points.length < 2) return <div className="small" style={{ height: 56, display: "grid", alignItems: "center" }}>The line starts with the second point.</div>;
  const vs = points.map((p) => p.v);
  const [lo, hi] = [Math.min(...vs), Math.max(...vs)];
  const y = (v: number) => (hi === lo ? 28 : 52 - ((v - lo) / (hi - lo)) * 48);
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * 300).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  return <svg className="spark" viewBox="0 0 300 56" preserveAspectRatio="none" role="img" aria-label="Index history"><path d={d} /></svg>;
}

export default async function IndexesPage() {
  const data = await getIndexes();
  return (
    <>
      <PageHead crumb="Indexes" title="Specula indexes">Baskets of on-chain prices, computed by the engine in the open: fixed members, equal weight, exact arithmetic.</PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 48 }}>
          {!data ? <Offline what="the indexes" /> : (
            <>
              <div className="grid3">
                {data.indexes.map((i) => (
                  <div key={i.index} className="panel soft" style={{ display: "flex", flexDirection: "column" }}>
                    <div className="panel-bar"><span>{i.index}</span><span className="right">{i.at ? utc(i.at) : "not computed yet"}</span></div>
                    <div className="stack" style={{ padding: 18, flex: 1 }}>
                      <h2 className="h3">{i.title}</h2>
                      <p className="small">{i.about}</p>
                      <div className="num" style={{ fontSize: 44, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1, marginTop: 8 }}>{i.value ?? "n/a"}</div>
                      <div className="label">{i.value ? `base 1000 / 24h ${i.change24hBps == null ? "n/a" : bps(i.change24hBps)}` : "waiting for its first point"}</div>
                      <Spark points={i.points} />
                      <div className="row" style={{ gap: 5, marginTop: "auto" }}>
                        {i.constituents.map((c) => <span key={c.symbol} className={`chip${c.priced ? " on" : ""}`}>{c.symbol}</span>)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid2" style={{ alignItems: "start" }}>
                <div className="stack">
                  <div className="mark"><i>A</i> How an index moves</div>
                  <p className="body">Each index starts at 1000. Every five minutes the engine takes the price of each member, divides it by the price at the last point, averages those ratios and multiplies the index by the result. Members are fixed and listed above. A member without a fresh price is left out of that step.</p>
                  <p className="small">An index is a calculation, not a product you can buy here, and not advice.</p>
                </div>
                <div className="stack">
                  <div className="mark"><i>B</i> On chain, through the oracle</div>
                  <p className="body">Any index or price is available as a report signed by the engine. Anyone can carry a report to the oracle contract; the contract checks the engine&apos;s signature, not the sender.</p>
                  <Code>{`GET /v1/oracle/index:ai      // a signed report: id, value, timestamp, signature
oracle.post(id, value, timestamp, signature);   // anyone may send it
oracle.read(bytes32("index:ai"), 1 hours);      // what a contract calls`}</Code>
                  <p className="small">{data.oracle.deployed ? `The oracle contract is at ${data.oracle.contract}.` : "The oracle contract is written and tested, and is not deployed yet. Signed reports are available now."}</p>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
