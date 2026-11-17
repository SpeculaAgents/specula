import type { Metadata } from "next";
import { Offline, PageHead } from "@/components/PageHead";
import { getQuality, getStatus } from "@/lib/engine";
import { ago, int, pct, short, utc } from "@/lib/format";
import { usageShown } from "@/lib/usage";

export const metadata: Metadata = { title: "Status", description: "Live health of every Specula feed and source: uptime, speed, failovers and quality." };

export default async function StatusPage() {
  const [st, quality] = await Promise.all([getStatus(), getQuality()]);
  const usage = usageShown(st?.stats);
  if (!st)
    return (
      <>
        <PageHead crumb="Status" title="Status">The health of every feed and source, measured by the engine itself.</PageHead>
        <section className="section"><div className="frame"><Offline what="status" /></div></section>
      </>
    );
  const q = new Map((quality?.feeds ?? []).map((x) => [x.feed, x]));
  const sources = st.feeds.flatMap((f) => f.sources);
  const troubled = sources.filter((s) => s.state === "down" || s.state === "degraded");
  const measured = st.feeds.filter((f) => f.uptime !== null);
  return (
    <>
      <PageHead crumb="Status" title={troubled.length ? `${troubled.length} ${troubled.length === 1 ? "source needs" : "sources need"} attention` : "All measured sources are answering"}>
        Measured by the engine about itself, as of {utc(st.now)}. A feed with a second source keeps answering when its first one fails.
      </PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 48 }}>
          <dl className={usage ? "kv four" : "kv three"}>
            <div><dt>Feed uptime, 24h</dt><dd>{pct(st.stats.uptime24h)}</dd></div>
            <div><dt>Sources answering</dt><dd>{st.stats.sourcesOk}<small>of {st.stats.sourcesSeen} measured</small></dd></div>
            {usage && <div><dt>Requests, 24h</dt><dd>{int(st.stats.requests24h)}</dd></div>}
            <div><dt>Avg response</dt><dd>{st.stats.avgMs24h === null ? "n/a" : `${st.stats.avgMs24h}`}<small>ms</small></dd></div>
          </dl>

          <div className="stack">
            <div className="mark"><i>A</i> Feeds</div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Feed</th><th>Uptime, 24h</th><th className="num">Collections</th><th className="num">Avg time</th><th className="num">Quality</th><th>Sources</th></tr></thead>
                <tbody>
                  {st.feeds.map((f) => (
                    <tr key={f.id}>
                      <td className="id"><a href={`/feeds/${f.id}`} className="link">{f.id}</a></td>
                      <td style={{ minWidth: 150 }}>
                        {f.uptime === null ? <span className="state idle"><i />not asked yet</span> : (
                          <span className="row" style={{ gap: 10, flexWrap: "nowrap" }}><span className="bar" style={{ flex: 1 }}><span style={{ width: `${f.uptime * 100}%` }} /></span><span className="num" style={{ fontSize: 13 }}>{pct(f.uptime, f.uptime === 1 ? 0 : 1)}</span></span>
                        )}
                      </td>
                      <td className="num">{int(f.collections)}</td>
                      <td className="num">{f.avgMs === null ? "n/a" : `${f.avgMs} ms`}</td>
                      <td className="num">{q.get(f.id)?.score ?? "n/a"}{q.get(f.id)?.grade ? ` ${q.get(f.id)!.grade}` : ""}</td>
                      <td>
                        <span className="row" style={{ gap: 10 }}>
                          {f.sources.length ? f.sources.map((s) => <span key={s.source} className={`state ${s.state}`} title={s.lastError ?? undefined}><i />{s.source}</span>) : <span className="state idle"><i />standing by</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">{measured.length} of {st.feeds.length} feeds have been asked in the last 24 hours. Uptime is the share of collections where at least one source answered.</p>
          </div>

          <div className="grid2" style={{ alignItems: "start" }}>
            <div className="stack">
              <div className="mark"><i>B</i> The chain index</div>
              <dl className="kv">
                <div><dt>Block read</dt><dd>{st.index.block ? int(st.index.block) : "n/a"}</dd></div>
                <div><dt>Behind the chain</dt><dd>{st.index.behindBlocks === null ? "n/a" : int(st.index.behindBlocks)}<small>blocks</small></dd></div>
                <div><dt>Trades indexed</dt><dd>{int(st.index.trades)}</dd></div>
                <div><dt>Tokens known</dt><dd>{int(st.index.tokens)}</dd></div>
                <div><dt>Pools known</dt><dd>{int(st.index.pools)}</dd></div>
                <div><dt>Holder tables</dt><dd>{int(st.index.holdersTracked)}</dd></div>
              </dl>
              <p className="small">Indexed since {utc(st.index.since)}. Last step {ago(st.index.lastTickAt)}.</p>
            </div>
            <div className="stack">
              <div className="mark"><i>C</i> The engine</div>
              <div className="table-wrap">
                <table className="t fit">
                  <tbody>
                    <tr><td className="muted">Version</td><td className="id">{st.version}</td></tr>
                    <tr><td className="muted">Signing address</td><td className="id">{short(st.engine, 10, 8)}</td></tr>
                    <tr><td className="muted">Up since</td><td className="id">{utc(st.startedAt)}</td></tr>
                    <tr><td className="muted">Payments</td><td><span className={`state ${st.payments.on ? "ok" : "idle"}`}><i />{st.payments.on ? "on" : "off, every answer is free"}</span></td></tr>
                    <tr><td className="muted">Summaries and answers</td><td className="id">{st.model === "standin" ? "built-in rule model" : "hosted model"}</td></tr>
                    {usage && <tr><td className="muted">Answers signed</td><td className="id">{int(st.stats.answersSigned)}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="mark"><i>D</i> Background jobs</div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Job</th><th className="num">Runs</th><th className="num">Failed</th><th className="num">Last took</th><th className="num">Last ran</th><th>Last problem</th></tr></thead>
                <tbody>
                  {st.jobs.map((j) => (
                    <tr key={j.name}><td className="id">{j.name}</td><td className="num">{int(j.runs)}</td><td className="num">{int(j.fails)}</td><td className="num">{j.lastMs} ms</td><td className="num">{ago(j.lastAt)}</td><td className="small">{j.lastError ? j.lastError.split("\n")[0].slice(0, 80) : "none"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
