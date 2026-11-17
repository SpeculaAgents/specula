import type { Metadata } from "next";
import { Boundary } from "@/components/Boundary";
import { Offline, PageHead } from "@/components/PageHead";
import { SignalTry } from "@/components/SignalTry";
import { getSignals } from "@/lib/engine";
import { ago, bps, int, pct, short } from "@/lib/format";
import { fireDetail as detail } from "@/lib/signal";

export const metadata: Metadata = { title: "Signals", description: "Rules over live data that fire as events happen, with a public record of what the price did in the hour after each one." };

export default async function SignalsPage() {
  const s = await getSignals();
  const fired = (s?.rules ?? []).filter((r) => r.record.fires > 0).sort((a, b) => b.record.fires - a.record.fires);
  const quiet = (s?.rules ?? []).filter((r) => r.record.fires === 0);
  return (
    <>
      <PageHead crumb="Signals" title="Signals, with their record">Rules that fire as things happen on the chain and in filings. One hour after each fire the engine measures what the price did, and publishes it here whether it looks good or not.</PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 48 }}>
          {!s ? <Offline what="signals" /> : (
            <>
              <dl className="kv four">
                <div><dt>Built-in signals</dt><dd>{s.rules.length}</dd></div>
                <div><dt>Fires so far</dt><dd>{int(s.fires)}</dd></div>
                <div><dt>Measured after 1h</dt><dd>{int(s.measured)}</dd></div>
                <div><dt>Agents&apos; own rules</dt><dd>{int(s.custom)}</dd></div>
              </dl>
              <div className="grid2" style={{ alignItems: "start" }}>
                <div className="stack">
                  <div className="mark"><i>A</i> Your own signal</div>
                  <p className="body">An agent keeps its own rules by saying them in plain words. Try a sentence to see the rule it becomes. Saving a rule and receiving its fires is done with the SDK.</p>
                </div>
                <Boundary><SignalTry /></Boundary>
              </div>
              <div className="stack">
                <div className="mark"><i>B</i> Latest fires</div>
                {s.recent.length ? (
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>When</th><th>Signal</th><th>Subject</th><th>What was seen</th><th className="num">1h after</th></tr></thead>
                      <tbody>
                        {s.recent.slice(0, 20).map((f) => (
                          <tr key={f.id}>
                            <td className="id muted">{ago(f.at)}</td>
                            <td>{f.name}</td>
                            <td className="id">{f.subject.startsWith("0x") ? short(f.subject) : f.subject}</td>
                            <td className="small">{detail(f.detail)}</td>
                            <td className="num">{f.after1h ? (f.after1h.moveBps === null ? "no price" : bps(f.after1h.moveBps)) : "pending"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty"><b>Nothing has fired yet</b>{s.rules.length} rules are watching the data. The first fire will be listed here.</div>}
              </div>
              <div className="stack">
                <div className="mark"><i>C</i> The record, rule by rule</div>
                {fired.length ? (
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>Signal</th><th className="num">Fires</th><th className="num">Measured</th><th className="num">Avg move, 1h</th><th className="num">Price up</th><th className="num">Followed through</th></tr></thead>
                      <tbody>
                        {fired.map((r) => (
                          <tr key={r.id}>
                            <td>{r.name}</td>
                            <td className="num">{int(r.record.fires)}</td>
                            <td className="num">{int(r.record.measured)}</td>
                            <td className="num">{r.record.after1h ? bps(r.record.after1h.averageMoveBps) : "pending"}</td>
                            <td className="num">{r.record.after1h ? pct(r.record.after1h.upShare, 0) : "pending"}</td>
                            <td className="num">{r.record.after1h?.followedThroughShare != null ? pct(r.record.after1h.followedThroughShare, 0) : "n/a"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty"><b>No record yet</b>A rule gets its first line here the first time it fires.</div>}
                {quiet.length > 0 && (
                  <div className="stack" style={{ gap: 10, marginTop: 8 }}>
                    <span className="label">{quiet.length} more {quiet.length === 1 ? "rule is" : "rules are"} watching and {quiet.length === 1 ? "has" : "have"} not fired yet</span>
                    <div className="row" style={{ gap: 6 }}>{quiet.map((r) => <span key={r.id} className="chip wrap">{r.name}</span>)}</div>
                  </div>
                )}
                <p className="small">Followed through is the share of fires where the price, an hour later, had moved in the signal&apos;s own direction. A record describes the past and is not advice.</p>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
