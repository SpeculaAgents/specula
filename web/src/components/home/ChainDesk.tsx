"use client";
import Link from "next/link";
import { useState } from "react";
import type { Fire } from "@/lib/types";
import { Fires, Launches, Tape } from "../desk/Desk";
import { ArrowRight } from "../Icons";
import { useLive } from "../Live";

const ROWS = 7;
const TABS = [["launches", "Launches"], ["trades", "Trades"], ["signals", "Signals"]] as const;

/** The hero's one live card: what is happening on Robinhood Chain right now, a few rows at a time. */
export function ChainPanel({ fires }: { fires: Fire[] }) {
  const { site, connected } = useLive();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("launches");
  const ix = site?.index;
  const count = tab === "launches" ? ix?.launches : tab === "trades" ? ix?.trades : null;
  return (
    <section className="tm-p hm-panel" aria-label="Live from Robinhood Chain">
      <header className="tm-ph">
        <h3><span className={`beacon${connected ? "" : " off"}`} /> Robinhood Chain, live</h3>
        <span className="tm-pm">
          <span className="tm-tabs" role="tablist" aria-label="What to show">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>
            ))}
          </span>
        </span>
      </header>
      {tab === "launches" ? <Launches fires={fires} rows={ROWS} /> : tab === "trades" ? <Tape rows={ROWS} /> : <Fires fires={fires} rows={ROWS} />}
      <footer className="tm-pf">
        <span>{count ? <><b>{count.toLocaleString("en-US")}</b> {tab === "launches" ? "launches seen" : "trades indexed"}</> : "Rules over the live data, as they fire"}</span>
        <Link href="/terminal" className="tm-link">Open the terminal <ArrowRight /></Link>
      </footer>
    </section>
  );
}
