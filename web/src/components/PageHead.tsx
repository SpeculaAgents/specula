import Link from "next/link";
import type { ReactNode } from "react";

export function PageHead({ crumb, title, children, aside }: { crumb: string; title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="pagehead">
      <div className="frame">
        <div className="crumbs">
          <Link href="/">Specula</Link>
          <span>/</span>
          <span style={{ color: "var(--ink)" }}>{crumb}</span>
        </div>
        <div className={aside ? "head" : undefined} style={aside ? { marginBottom: 0, alignItems: "end" } : undefined}>
          <div>
            <h1 className="h1">{title}</h1>
            {children && <p className="lede">{children}</p>}
          </div>
          {aside}
        </div>
      </div>
    </header>
  );
}

export const Offline = ({ what = "this page" }: { what?: string }) => (
  <div className="empty">
    <b>The engine is not answering</b>
    Nothing is shown for {what} until it does. No number on this site is ever filled in by hand.
  </div>
);
