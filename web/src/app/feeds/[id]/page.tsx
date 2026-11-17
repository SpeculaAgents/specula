import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Answer } from "@/components/answer/Answer";
import { Code } from "@/components/Code";
import { Offline, PageHead } from "@/components/PageHead";
import { Runner } from "@/components/Runner";
import { getFeed, getQuality } from "@/lib/engine";
import { ago, pct, span } from "@/lib/format";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const f = /^[a-z]+\.[a-z]+$/.test(id) ? await getFeed(id) : null;
  return f ? { title: `${f.title} (${f.id})`, description: f.summary } : { title: "Feed" };
}

export default async function Feed({ params }: Props) {
  const { id } = await params;
  if (!/^[a-z]+\.[a-z]+$/.test(id)) notFound();
  const [f, quality] = await Promise.all([getFeed(id), getQuality()]);
  if (!f) {
    // Either the feed does not exist or the engine is down; tell them apart by asking for the catalog shape.
    if (quality) notFound();
    return (
      <>
        <PageHead crumb="Feeds" title={id} />
        <section className="section"><div className="frame"><Offline what="this feed" /></div></section>
      </>
    );
  }
  const q = quality?.feeds.find((x) => x.feed === f.id);
  const sdkCall = `const answer = await specula.get("${f.id}", ${JSON.stringify(f.example)});\nconsole.log(answer.data, answer.source, answer.meta.price.amount);`;
  return (
    <>
      <PageHead
        crumb={`Feeds / ${f.id}`}
        title={f.title}
        aside={
          <dl className="kv" style={{ alignSelf: "end" }}>
            <div><dt>Live price</dt><dd>{f.price.live.amount}<small>USDG</small></dd></div>
            <div><dt>Stays live for</dt><dd>{span(f.liveForSeconds)}</dd></div>
            <div><dt>Uptime, 24h</dt><dd>{f.uptime24h === null ? "n/a" : pct(f.uptime24h, f.uptime24h === 1 ? 0 : 2)}</dd></div>
            <div><dt>Quality</dt><dd>{q?.score ?? "n/a"}{q?.grade && <small>grade {q.grade}</small>}</dd></div>
          </dl>
        }
      >
        {f.summary}
      </PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 48 }}>
          <div className="stack">
            <div className="mark"><i>A</i> Try it</div>
            <Runner path={`/v1/feeds/${f.id}`} params={f.params} initial={f.example} label="Ask the engine" />
            <p className="small">This sends a real request to the live engine through your free daily allowance. The reply is exactly what an agent receives.</p>
          </div>

          <div className="grid2" style={{ alignItems: "start" }}>
            <div className="stack">
              <div className="mark"><i>B</i> Parameters</div>
              {f.params.length ? (
                <div className="table-wrap">
                  <table className="t fit">
                    <thead><tr><th>Name</th><th>Type</th><th>What it is</th></tr></thead>
                    <tbody>
                      {f.params.map((p) => (
                        <tr key={p.name}>
                          <td className="id">{p.name}{p.required ? " *" : ""}</td>
                          <td className="id muted">{p.type}{p.default ? ` = ${p.default}` : ""}</td>
                          <td>{p.doc}{p.values ? ` One of: ${p.values.join(", ")}.` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="body">This feed takes no parameters.</p>
              )}
            </div>
            <div className="stack">
              <div className="mark"><i>C</i> Price by freshness</div>
              <div className="table-wrap">
                <table className="t fit">
                  <thead><tr><th>Ask with</th><th>The answer may be</th><th className="num">USDG per call</th></tr></thead>
                  <tbody>
                    <tr><td className="id">fresh=live</td><td>at most {span(f.liveForSeconds)} old</td><td className="num">{f.price.live.amount}</td></tr>
                    <tr><td className="id">fresh=recent</td><td>at most {span(Math.max(f.liveForSeconds, 300))} old</td><td className="num">{f.price.recent.amount}</td></tr>
                    <tr><td className="id">fresh=delayed</td><td>at most {span(Math.max(f.liveForSeconds, 3600))} old</td><td className="num">{f.price.delayed.amount}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="mark"><i>D</i> {f.agree ? "Sources, all asked and compared" : "Sources, in the order they are tried"}</div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>#</th><th>Source</th><th>State</th><th className="num">Answered</th><th className="num">Failed</th><th className="num">Avg time</th><th className="num">Last answer</th></tr></thead>
                <tbody>
                  {f.sources.map((s, i) => {
                    const h = f.health.find((x) => x.source === s);
                    return (
                      <tr key={s}>
                        <td className="id muted">{i + 1}</td>
                        <td className="id">{s}</td>
                        <td><span className={`state ${h?.state ?? "idle"}`}><i />{h ? h.state : i === 0 ? "not asked yet" : "standing by"}</span></td>
                        <td className="num">{h?.ok ?? 0}</td>
                        <td className="num">{h?.fail ?? 0}</td>
                        <td className="num">{h?.avgMs != null ? `${h.avgMs} ms` : "n/a"}</td>
                        <td className="num">{h?.lastOkAt ? ago(h.lastOkAt) : "n/a"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {f.agree && (
              <p className="small">Every source is asked each time. The answer says how many agreed and how far apart they were. Sources within {f.agree.toleranceBps / 100}% of each other agree; one that is stale, frozen or out of line is dropped and named, and when too few agree there is no answer and no charge.</p>
            )}
            {q && q.parts.length > 0 && (
              <p className="small">Quality {q.score} of 100: {q.parts.map((p) => `${p.name} ${p.score} (${p.detail})`).join("; ")}.</p>
            )}
          </div>

          <div className="stack" style={{ gap: 48 }}>
            <div className="stack">
              <div className="mark"><i>E</i> The last real answer</div>
              {f.exampleAnswer ? (
                <Answer body={f.exampleAnswer} />
              ) : (
                <div className="empty"><b>Not collected yet</b>The engine keeps the last answer for these example parameters. Run the request above to see one now.</div>
              )}
            </div>
            <div className="stack">
              <div className="mark"><i>F</i> In code</div>
              <Code>{sdkCall}</Code>
              <Code>{`curl "https://speculaagents.fun/api${f.path}"`}</Code>
              {f.stream && <p className="small">New data on this feed is also pushed on the <span className="inline">{f.stream}</span> stream.</p>}
              <Link href="/docs" className="arrow" style={{ marginTop: 6 }}>How paying works</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
