import type { Metadata } from "next";
import { Boundary } from "@/components/Boundary";
import { Code } from "@/components/Code";
import { Offline, PageHead } from "@/components/PageHead";
import { ProofBox } from "@/components/ProofBox";
import { getCatalog, getFeed, getRoots, getSite } from "@/lib/engine";
import { int, short, utc } from "@/lib/format";
import { SNIPPETS } from "@/lib/snippets";
import { usageShown } from "@/lib/usage";

export const metadata: Metadata = { title: "Verify", description: "How to check a Specula answer yourself: the signature on every answer and the hourly Merkle root it is sealed into." };

export default async function Verify() {
  const [roots, cat, site] = await Promise.all([getRoots(), getCatalog(), getSite()]);
  const usage = usageShown(site?.stats);
  // A real digest to try: the last answer of the first feed that has one.
  let sample: string | null = null;
  for (const f of (cat?.feeds ?? []).slice(0, 2)) sample ??= (await getFeed(f.id))?.exampleAnswer?.proof.digest ?? null;
  return (
    <>
      <PageHead crumb="Verify" title="Check it yourself">Every answer is signed when it is collected. Every hour, all the answers signed in it are sealed into one fingerprint. Neither needs you to trust this site.</PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 48 }}>
          {!roots ? <Offline what="verification" /> : (
            <>
              <dl className={usage ? "kv four" : "kv three"}>
                <div><dt>Hours sealed</dt><dd>{int(roots.sealed)}</dd></div>
                {usage && <div><dt>Answers this hour</dt><dd>{int(roots.openHour.answersSoFar)}</dd></div>}
                <div><dt>This hour seals</dt><dd style={{ fontSize: "clamp(16px, 2.4vw, 22px)" }}>{utc(roots.openHour.sealsAt).slice(11)}</dd></div>
                <div><dt>Signing address</dt><dd style={{ fontSize: "clamp(16px, 2.4vw, 22px)" }}>{short(roots.engine)}</dd></div>
              </dl>
              <div className="grid2" style={{ alignItems: "start" }}>
                <div className="stack">
                  <div className="mark"><i>A</i> The signature</div>
                  <p className="body">Write the answer&apos;s feed, parameters, data, source and collection time as JSON with sorted keys, hash it, and recover the signer. It must be the engine&apos;s address. The SDK does this on every call; here it is by hand.</p>
                  <Code>{SNIPPETS.verify}</Code>
                </div>
                <div className="stack">
                  <div className="mark"><i>B</i> The proof</div>
                  <p className="body">Once an hour is sealed, any answer from it has a short proof that leads to that hour&apos;s root. An answer from the open hour says when it will be sealed.</p>
                  <Boundary><ProofBox sample={sample} /></Boundary>
                </div>
              </div>
              <div className="stack">
                <div className="mark"><i>C</i> Sealed hours</div>
                {roots.roots.length ? (
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th>Hour (UTC)</th>{usage && <th className="num">Answers</th>}<th>Root</th><th>On chain</th></tr></thead>
                      <tbody>
                        {roots.roots.map((r) => (
                          <tr key={r.hour}>
                            <td className="id">{utc(r.from)}</td>
                            {usage && <td className="num">{int(r.answers)}</td>}
                            <td className="id">{short(r.root, 14, 10)}</td>
                            <td>{r.anchored ? <span className="state ok"><i />{short(r.anchored.transaction, 8, 6)}</span> : <span className="state idle"><i />not posted</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty"><b>No hour sealed yet</b>The first root appears when the hour that is open now has ended.</div>}
                <p className="small">{roots.anchor ? "Each root is posted to the anchor contract, where anyone can check a proof without this site." : "Roots are signed by the engine and kept here. Posting them on chain starts when the anchor contract is deployed."}</p>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
