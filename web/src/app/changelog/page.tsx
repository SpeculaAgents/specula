import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { CHANGELOG } from "@/lib/changelog";

export const metadata: Metadata = { title: "Changelog", description: "What changed in Specula, newest first." };

export default function Changelog() {
  return (
    <>
      <PageHead crumb="Changelog" title="Changelog">What changed, newest first.</PageHead>
      <section className="section">
        <div className="frame">
          <ol className="road">
            {CHANGELOG.map((c) => (
              <li key={c.title} style={{ alignItems: "start" }}>
                <span className="rn" style={{ gridColumn: "1 / -1", whiteSpace: "nowrap" }}>{c.date}</span>
                <span className="rt" style={{ gridColumn: "1 / -1" }}>{c.title}</span>
                <ul className="rd" style={{ gridColumn: "1 / -1", display: "grid", gap: 4, paddingLeft: 18, listStyle: "square", maxWidth: "80ch" }}>
                  {c.items.map((i) => <li key={i} style={{ display: "list-item", padding: 0, border: 0 }}>{i}</li>)}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
