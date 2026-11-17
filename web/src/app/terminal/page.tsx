import type { Metadata } from "next";
import { Boundary } from "@/components/Boundary";
import { StatusBar } from "@/components/desk/Desk";
import { Live } from "@/components/Live";
import Link from "next/link";
import { Offline } from "@/components/PageHead";
import { Terminal } from "@/components/Terminal";
import { getCatalog, getSignals, getSite } from "@/lib/engine";
import "../desk.css";

export const metadata: Metadata = { title: "Terminal", description: "The agent's view of Specula in a browser: new launches, the trade tape, signals, the price board and a command line over every feed." };

export default async function TerminalPage() {
  const [site, cat, signals] = await Promise.all([getSite(), getCatalog(), getSignals()]);
  return (
    <>
      <header className="pagehead tt-head">
        <div className="frame">
          <div className="crumbs">
            <Link href="/">Specula</Link>
            <span>/</span>
            <span style={{ color: "var(--ink)" }}>Terminal</span>
          </div>
          <div className="tt-head-row">
            <h1 className="h1">The terminal</h1>
            <p>What an agent sees, drawn for a person. Everything on the board is live; the command line reaches every feed.</p>
          </div>
        </div>
      </header>
      <section className="section">
        <div className="frame">
          {site ? (
            <Live initial={site}>
              <div className="tt-stack">
                <Boundary><StatusBar /></Boundary>
                <Boundary label="The terminal could not be drawn.">
                  <Terminal feeds={cat?.feeds ?? []} fires={signals?.recent ?? []} rules={signals?.rules.length ?? 0} />
                </Boundary>
              </div>
            </Live>
          ) : <Offline what="the terminal" />}
        </div>
      </section>
    </>
  );
}
