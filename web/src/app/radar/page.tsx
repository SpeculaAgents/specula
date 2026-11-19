import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { getRadar, type RadarTrade } from "@/lib/engine";
import { usd } from "@/lib/format";

export const metadata: Metadata = { title: "Insider radar", description: "What the insiders of every stock on the chain bought and sold on the open market, read from their Form 4 filings with the SEC." };

const name = (s: string) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

function TradeRow({ t }: { t: RadarTrade }) {
  return (
    <tr>
      <td className="id"><b>{t.ticker}</b></td>
      <td>{name(t.owner)}<span className="small" style={{ display: "block" }}>{t.role}</span></td>
      <td><span className={`state ${t.side === "buy" ? "ok" : ""}`}><i />{t.side === "buy" ? "Bought" : "Sold"}</span></td>
      <td className="num">{usd(t.valueUsd)}</td>
      <td className="id">{t.date ?? "n/a"}</td>
      <td><a className="link" href={t.url} target="_blank" rel="noopener noreferrer">Form 4</a></td>
    </tr>
  );
}

export default async function RadarPage() {
  const r = await getRadar();
  const ready = !!r?.updatedAt;
  return (
    <>
      <PageHead crumb="Insider radar" title="Insider radar">
        What the officers and directors of every stock on the chain bought and sold with their own money, read straight from their Form 4 filings with the SEC.
      </PageHead>

      <section className="section">
        <div className="frame">
          <dl className="kv four">
            <div><dt>Sold by insiders</dt><dd>{ready ? usd(r!.totals.soldUsd) : "n/a"}</dd></div>
            <div><dt>Bought by insiders</dt><dd>{ready ? usd(r!.totals.boughtUsd) : "n/a"}</dd></div>
            <div><dt>Companies read</dt><dd>{ready ? r!.totals.companies : "n/a"}</dd></div>
            <div><dt>Last reading, UTC</dt><dd>{ready ? `${r!.updatedAt!.slice(5, 10)} ${r!.updatedAt!.slice(11, 16)}` : "Building"}</dd></div>
          </dl>
        </div>
      </section>

      <section className="section">
        <div className="frame stack" style={{ gap: 20 }}>
          <h2 className="h2" style={{ margin: 0 }}>The biggest trades</h2>
          {ready && r!.biggest.length ? (
            <div className="table-wrap">
              <table className="t fit">
                <thead><tr><th>Stock</th><th>Insider</th><th>Trade</th><th className="num">Value</th><th>Date</th><th>Filing</th></tr></thead>
                <tbody>{r!.biggest.map((t, i) => <TradeRow key={`${t.url}-${i}`} t={t} />)}</tbody>
              </table>
            </div>
          ) : (
            <div className="empty"><b>The first reading is being built</b>The engine reads every company's filings one by one, at the pace the SEC asks for.</div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="frame stack" style={{ gap: 20 }}>
          <h2 className="h2" style={{ margin: 0 }}>Company by company</h2>
          {ready && r!.companies.length ? (
            <div className="table-wrap">
              <table className="t fit">
                <thead><tr><th>Stock</th><th className="num">Sold</th><th className="num">Bought</th><th className="num">Trades</th><th>Biggest</th><th>Latest</th></tr></thead>
                <tbody>
                  {r!.companies.map((c) => (
                    <tr key={c.ticker}>
                      <td className="id"><b>{c.ticker}</b><span className="small" style={{ display: "block" }}>{name(c.company)}</span></td>
                      <td className="num">{usd(c.soldUsd)}</td>
                      <td className="num">{usd(c.boughtUsd)}</td>
                      <td className="num">{c.sells + c.buys}</td>
                      <td>{c.biggest ? <>{name(c.biggest.owner)}<span className="small" style={{ display: "block" }}>{c.biggest.side === "buy" ? "bought" : "sold"} {usd(c.biggest.valueUsd)}</span></> : <span className="small">No open-market trades</span>}</td>
                      <td className="id">{c.lastDate ?? "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="small" style={{ maxWidth: "70ch" }}>
            {r?.note ?? "Open-market purchases and sales from each company's latest Form 4 filings. Not advice."} Agents get the same data signed, per company, from the <Link className="link" href="/feeds/sec.insiders">sec.insiders</Link> feed. Read <Link className="link" href="/own-risk">Own risk</Link>.
          </p>
        </div>
      </section>
    </>
  );
}
