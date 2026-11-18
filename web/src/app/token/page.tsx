import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { BuybackClock } from "@/components/BuybackClock";
import { getToken } from "@/lib/engine";
import { short, tiny, utc } from "@/lib/format";

export const metadata: Metadata = { title: "Token", description: "$SPECULA: fees bought back and burned by the team wallet, every buyback and burn on the record." };

const EXPLORER = "https://robinhoodchain.blockscout.com";

export default async function Token() {
  const t = await getToken();
  const live = !!t?.live;
  const bb = t?.buyback ?? null;
  const fomo = process.env.SPECULA_FOMO_URL || null;
  const wallet = bb?.wallet ?? null;
  const burned = live ? (t?.totalBurned && Number(t.totalBurned) > 0 ? t.totalBurned : bb?.burned ?? "0") : null;
  const runs = bb?.recent ?? [];

  return (
    <>
      <PageHead crumb="Token" title="$SPECULA">
        Fees from trading $SPECULA are bought back and burned by the team wallet, every {bb?.everyMin ?? 30} minutes. Every buy and every burn is listed here with its transaction.
      </PageHead>

      <section className="section">
        <div className="frame bb-top">
          <BuybackClock nextAt={live && bb?.on ? bb.nextAt : null} everyMin={bb?.everyMin ?? 30} live={live && !!bb?.on} serverNow={Date.now()} />
          <dl className="kv bb-kv">
            <div><dt>Burned so far</dt><dd>{burned === null ? "0" : tiny(burned)}<small>tokens</small></dd></div>
            <div><dt>Spent on buybacks</dt><dd>{tiny(bb?.ethSpent ?? "0")}<small>ETH</small></dd></div>
            <div><dt>Buybacks</dt><dd>{bb?.runs ?? 0}</dd></div>
            <div><dt>Last buyback</dt><dd className="bb-small">{runs[0] ? utc(runs[0].time) : "None yet"}</dd></div>
          </dl>
        </div>
      </section>

      <section className="section">
        <div className="frame">
          <ol className="bb-steps">
            <li><span className="num">01</span><b>Fees arrive</b><p>Trading $SPECULA pays a fee. Part of it goes to the team wallet that buys back.</p></li>
            <li><span className="num">02</span><b>The team wallet buys</b><p>Every {bb?.everyMin ?? 30} minutes it buys $SPECULA with exactly the fees that came in since the last run.</p></li>
            <li><span className="num">03</span><b>It burns what it bought</b><p>Straight after, it burns exactly the tokens that buy delivered. The supply only goes down.</p></li>
          </ol>
          {wallet && (
            <div className="bb-links">
              {fomo && <a className="btn" href={fomo} target="_blank" rel="noopener noreferrer">Watch the team wallet on FOMO</a>}
              <a className="btn ghost" href={`${EXPLORER}/address/${wallet}`} target="_blank" rel="noopener noreferrer">The wallet on the explorer</a>
              <span className="small num">{short(wallet, 8, 6)}</span>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="frame stack" style={{ gap: 20 }}>
          <h2 className="h2" style={{ margin: 0 }}>Every buyback and burn</h2>
          {runs.length > 0 ? (
            <div className="table-wrap">
              <table className="t fit">
                <thead><tr><th>When</th><th className="num">ETH in</th><th className="num">Burned</th><th>Buy</th><th>Burn</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.buyTx}>
                      <td className="id">{utc(r.time)}</td>
                      <td className="num">{tiny(r.eth)}</td>
                      <td className="num">{tiny(r.burned)}</td>
                      <td className="id"><a className="link" href={`${EXPLORER}/tx/${r.buyTx}`} target="_blank" rel="noopener noreferrer">{short(r.buyTx, 8, 6)}</a></td>
                      <td className="id">{r.burnTx ? <a className="link" href={`${EXPLORER}/tx/${r.burnTx}`} target="_blank" rel="noopener noreferrer">{short(r.burnTx, 8, 6)}</a> : "next run"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty"><b>No buybacks yet</b>{live ? "The first buyback and burn will appear here with both transactions." : "This list fills from the first buyback after launch."}</div>
          )}
          <p className="small" style={{ maxWidth: "70ch" }}>
            A token can lose all of its value. Nothing on this site is advice or a promise. Read <Link className="link" href="/own-risk">Own risk</Link> before you do anything with it.
          </p>
        </div>
      </section>
    </>
  );
}
