import type { Metadata } from "next";
import { Boundary } from "@/components/Boundary";
import { PageHead } from "@/components/PageHead";
import { AskBox } from "@/components/AskBox";
import { getBriefing } from "@/lib/engine";
import { utc } from "@/lib/format";

export const metadata: Metadata = { title: "Ask the data", description: "Ask Specula a question in plain words. The answer is written only from live, signed data, and every sentence cites its source." };

export default async function Ask() {
  const b = await getBriefing();
  return (
    <>
      <PageHead crumb="Ask" title="Ask the data">A question in plain words, answered only from data the engine has collected and signed. Every sentence carries the number of the fact under it.</PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 56 }}>
          <Boundary><AskBox /></Boundary>
          <div className="stack">
            <div className="mark"><i>B</i> Today&apos;s briefing</div>
            {b && b.sections.length ? (
              <div className="grid2">
                {b.sections.map((s) => (
                  <div key={s.title} className="card">
                    <span className="n">{s.title}</span>
                    <ul className="stack" style={{ gap: 8 }}>
                      {s.lines.map((l) => (
                        <li key={l.text} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "baseline" }}>
                          <span>{l.text}</span>
                          <a className="cite" href={`/feeds/${l.feed}`} style={{ margin: 0 }}>{l.feed}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty"><b>No briefing yet</b>The engine writes one each day from the prices, the chain, the signals and the filings it has seen.</div>
            )}
            {b?.at && <p className="small">Written {utc(b.at)} from the engine&apos;s own data. Agents get the same briefing from the answers.briefing feed.</p>}
          </div>
        </div>
      </section>
    </>
  );
}
