import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { getArchive, getBounties, getDemand, getIndexes, getLab, getMarket, getRoots, getSignals, getStatus } from "@/lib/engine";
import { PHASES, STAGE_LABEL } from "@/lib/roadmap";

export const metadata: Metadata = { title: "Roadmap", description: "All 22 phases of Specula, with what is live today read from the running engine." };

export default async function Roadmap() {
  const [status, signals, roots, indexes, market, bounties, archive, lab, demand] = await Promise.all([getStatus(), getSignals(), getRoots(), getIndexes(), getMarket(), getBounties(), getArchive(), getLab(), getDemand()]);
  const seen = { status, signals, roots, indexes, market, bounties, archive, lab, demand };
  const rows = PHASES.map((p) => ({ ...p, st: p.stage(seen), why: p.note?.(seen) ?? null }));
  const count = (s: string) => rows.filter((r) => r.st === s).length;
  return (
    <>
      <PageHead crumb="Roadmap" title="Twenty-two phases">
        The whole plan, in order. A phase is marked live only when the running engine reports that it works; nothing here is switched on by hand.
      </PageHead>
      <section className="section">
        <div className="frame">
          <dl className="kv four" style={{ marginBottom: 40 }}>
            <div><dt>Live</dt><dd>{count("live")}</dd></div>
            <div><dt>Partly live</dt><dd>{count("part")}</dd></div>
            <div><dt>Built</dt><dd>{count("built")}</dd></div>
            <div><dt>Ahead</dt><dd>{count("next") + count("later")}</dd></div>
          </dl>
          <ol className="road">
            {rows.map((r) => (
              <li key={r.n} className={r.st === "later" || r.st === "next" ? "later" : undefined}>
                <span className="rn">{r.n}</span>
                <span className="rt">{r.title}</span>
                <span className="rd">
                  {r.text}
                  {r.why && <span className="small" style={{ display: "block", marginTop: 4 }}>{r.why}</span>}
                </span>
                <span className="rs">
                  <span className={`state ${r.st === "live" ? "ok" : r.st === "later" || r.st === "next" ? "idle" : ""}`}><i />{STAGE_LABEL[r.st]}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
