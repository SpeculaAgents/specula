import Link from "next/link";
import { FOOT, SITE } from "@/lib/site";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="foot">
      <div className="frame">
        <div className="foot-grid">
          <div className="stack">
            <Link href="/" className="brand" aria-label="Specula, home">
              <Logo />
            </Link>
            <p className="small" style={{ maxWidth: "34ch" }}>
              The data terminal for AI agents. Every answer bought by the request and signed by the engine.
            </p>
          </div>
          {FOOT.map((col) => (
            <div key={col.title}>
              <h4>{col.title}</h4>
              <ul>
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="foot-base">
          <span>{SITE.risk}</span>
          <span>
            <a href={SITE.github} target="_blank" rel="noreferrer">GitHub</a> / <a href={SITE.x} target="_blank" rel="noreferrer">X</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
