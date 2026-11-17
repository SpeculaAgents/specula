import type { Metadata } from "next";
import { FeedRow } from "@/components/FeedRow";
import { Offline, PageHead } from "@/components/PageHead";
import { Reveal } from "@/components/Reveal";
import { getCatalog, getQuality } from "@/lib/engine";
import { pct } from "@/lib/format";

export const metadata: Metadata = { title: "Feed catalog", description: "Every Specula feed: what it answers, the price per call, how fresh it is, where it comes from and how often it has answered." };

const ORDER = ["chain", "companies", "economy", "signals", "answers", "indexes", "archive", "lab", "market"];

export default async function Feeds() {
  const [cat, quality] = await Promise.all([getCatalog(), getQuality()]);
  const grade = new Map((quality?.feeds ?? []).map((q) => [q.feed, q.grade]));
  const groups = ORDER.map((g) => ({ id: g, feeds: (cat?.feeds ?? []).filter((f) => f.group === g) })).filter((g) => g.feeds.length);
  return (
    <>
      <PageHead crumb="Feeds" title="The feed catalog">
        Every feed states what it answers, what one call costs, how long an answer stays live, its sources and how it has performed. Prices are per call, in USDG.
      </PageHead>
      <section className="section">
        <div className="frame">
          {!cat ? (
            <Offline what="the catalog" />
          ) : (
            <>
              <dl className="kv four" style={{ marginBottom: 40 }}>
                <div><dt>Feeds</dt><dd>{cat.count}</dd></div>
                <div><dt>Free calls a day</dt><dd>{cat.freeDaily.wallet}<small>per wallet</small></dd></div>
                <div><dt>A few minutes old</dt><dd>{pct(0.5, 0)}<small>of the price</small></dd></div>
                <div><dt>Up to an hour old</dt><dd>{pct(0.2, 0)}<small>of the price</small></dd></div>
              </dl>
              <nav className="row" style={{ gap: 6, margin: "8px 0 48px" }} aria-label="Groups">
                {groups.map((g) => (
                  <a key={g.id} href={`#${g.id}`} className="chip on">{g.feeds[0].groupTitle} <span className="muted">{g.feeds.length}</span></a>
                ))}
              </nav>
              {groups.map((g) => (
                <div key={g.id} id={g.id} className="group">
                  <div className="group-title">
                    <h2 className="h2" style={{ fontSize: "clamp(26px, 4vw, 36px)" }}>{g.feeds[0].groupTitle}</h2>
                    <span className="label">{g.feeds.length} feeds</span>
                  </div>
                  <Reveal className="feed-list">
                    {g.feeds.map((f) => <FeedRow key={f.id} f={f} grade={grade.get(f.id)} />)}
                  </Reveal>
                </div>
              ))}
              <div className="grid2" style={{ marginTop: 64 }}>
                <div className="stack">
                  <h3 className="h3">Bulk levels</h3>
                  <p className="body" style={{ fontSize: 15 }}>What a wallet paid over the last 30 days sets its level. The discount applies to every call, on top of the freshness tier.</p>
                </div>
                <div className="table-wrap">
                  <table className="t fit">
                    <thead><tr><th>Level</th><th className="num">Paid in 30 days</th><th className="num">Discount</th></tr></thead>
                    <tbody>
                      {cat.levels.map((l) => (
                        <tr key={l.level}><td className="id">{l.level}</td><td className="num">{l.minSpend === "0" ? "any" : `${l.minSpend} USDG`}</td><td className="num">{pct(l.offBps / 10000, 0)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
