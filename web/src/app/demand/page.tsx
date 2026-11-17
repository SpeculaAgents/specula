import type { Metadata } from "next";
import { Offline, PageHead } from "@/components/PageHead";
import { getDemand, getSite } from "@/lib/engine";
import { int } from "@/lib/format";
import { USAGE_MIN_PAID_ANSWERS, usageShown } from "@/lib/usage";

export const metadata: Metadata = { title: "Data index", description: "Which data AI agents ask Specula for most, from the engine's own request log." };

export default async function Demand() {
  const [d, site] = await Promise.all([getDemand(), getSite()]);
  const usage = usageShown(site?.stats);
  return (
    <>
      <PageHead crumb="Data index" title="What agents ask for">An open ranking of the data agents request most, counted from the engine&apos;s own log over the last seven days.</PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 40 }}>
          {!d ? <Offline what="the data index" /> : !usage ? (
            <div className="empty"><b>{`The ranking opens at ${USAGE_MIN_PAID_ANSWERS.toLocaleString("en-US")} paid answers`}</b>Below that there are too few requests for a ranking to mean anything. It fills in by itself from the engine&apos;s log.</div>
          ) : (
            <>
              <dl className="kv">
                <div><dt>Requests, 7 days</dt><dd>{int(d.calls)}</dd></div>
                <div><dt>Feeds asked for</dt><dd>{int(d.feedsAsked)}</dd></div>
              </dl>
              {d.feeds.length ? (
                <ol className="road">
                  {d.feeds.map((f) => (
                    <li key={f.feed}>
                      <span className="rn">{String(f.rank).padStart(2, "0")}</span>
                      <span className="rt"><a href={`/feeds/${f.feed}`}>{f.title}</a><span className="small" style={{ display: "block", fontWeight: 400, fontFamily: "var(--mono)", fontSize: 12.5 }}>{f.feed}</span></span>
                      <span className="rd"><span className="bar" style={{ display: "block", marginTop: 10 }}><span style={{ width: `${Math.max(2, f.shareBps / 100)}%` }} /></span></span>
                      <span className="rs num" style={{ fontSize: 14 }}>{int(f.calls7d)} calls · {(f.shareBps / 100).toFixed(1)}%</span>
                    </li>
                  ))}
                </ol>
              ) : <div className="empty"><b>No requests in the last seven days</b>The ranking fills as agents ask for data.</div>}
              <p className="small">Counted per request the engine served, free and paid alike. Private feeds are left out.</p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
