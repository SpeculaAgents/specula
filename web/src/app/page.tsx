import Link from "next/link";
import { Boundary } from "@/components/Boundary";
import { CodeTabs } from "@/components/CodeTabs";
import { FeedRow } from "@/components/FeedRow";
import { ArrowRight } from "@/components/Icons";
import { Live } from "@/components/Live";
import { Reveal } from "@/components/Reveal";
import { ChainPanel } from "@/components/home/ChainDesk";
import { Exchange, type Shown } from "@/components/home/Exchange";
import { getCatalog, getFeed, getSignals, getSite } from "@/lib/engine";
import { short, utc } from "@/lib/format";
import { SNIPPETS } from "@/lib/snippets";
import type { FeedDetail, FeedEntry } from "@/lib/types";
import { checkSignature } from "@/lib/verify";
import "./desk.css";
import "./home.css";

/** The answers played in "how it works": one per kind of data, with the fields of the answer worth reading first. */
const SHOWN: { id: string; label: string; pick: string[] }[] = [
  { id: "chain.price", label: "A price", pick: ["symbol", "price", "quote", "name", "session", "updatedAt"] },
  { id: "sec.insiders", label: "A filing", pick: ["openMarket"] },
  { id: "macro.series", label: "A statistic", pick: ["title", "latest"] },
];
const DATA_LINES = 6;
/** The catalog teaser: chain data first, then one each of the rest. */
const PICKS = ["chain.launches", "chain.snipers", "chain.smartmoney", "chain.price", "sec.insiders", "macro.snapshot"];
const STEPS: [string, string][] = [
  ["The agent asks", "A plain request for one feed: a launch list, a price, a company's events."],
  ["The engine names the price", "Inside the free allowance the answer comes straight back. After it, the reply is a 402 with the exact amount."],
  ["The agent signs", "A one-time transfer of that amount in USDG, from the agent's own wallet. Nothing else can be taken with it."],
  ["The answer arrives signed", "With its source and collection time. Payment settles only after the answer is ready."],
];

const hex = (s: string) => s.replace(/0x[0-9a-fA-F]{24,}/g, (m) => `${m.slice(0, 10)}…${m.slice(-6)}`);

/** One real signed answer, laid out as the lines an agent receives. The signature is checked here, on the server. */
async function shown(detail: FeedDetail | null, label: string, pick: string[]): Promise<Shown | null> {
  const a = detail?.exampleAnswer;
  if (!detail || !a || typeof a.data !== "object" || a.data === null) return null;
  const all = a.data as Record<string, unknown>;
  const picked = Object.fromEntries(pick.filter((k) => k in all).map((k) => [k, all[k]]));
  const body = JSON.stringify(Object.keys(picked).length ? picked : all, null, 2).split("\n").slice(1, -1);
  const cut = body.slice(0, DATA_LINES);
  const more = cut.length < body.length || Object.keys(picked).length < Object.keys(all).length;
  if (cut.length) cut[cut.length - 1] = cut[cut.length - 1].replace(/,$/, "") + (more ? "," : "");
  const lines = [
    "{",
    `  "feed": ${JSON.stringify(a.feed)},`,
    `  "params": ${JSON.stringify(a.params)},`,
    `  "data": {`,
    ...cut.map((l) => `  ${l}`),
    ...(more ? ["    …"] : []),
    "  },",
    `  "source": ${JSON.stringify(a.source)},`,
    `  "collectedAt": ${a.collectedAt},`,
    `  "proof": {`,
    `    "engine": ${JSON.stringify(a.proof.engine)},`,
    `    "digest": ${JSON.stringify(a.proof.digest)},`,
    `    "signature": ${JSON.stringify(a.proof.signature)}`,
    "  }",
    "}",
  ].map(hex);
  const checked = await checkSignature(a).catch(() => false);
  return { id: detail.id, label, title: detail.title, path: detail.path, amount: detail.price.live.amount, asset: detail.asset, lines, source: a.source, collected: utc(a.collectedAtIso), signer: short(a.proof.engine, 8, 6), checked };
}

export default async function Home() {
  const [site, catalog, signals, ...details] = await Promise.all([getSite(), getCatalog(), getSignals(), ...SHOWN.map((s) => getFeed(s.id))]);
  const feeds = catalog?.feeds ?? [];
  const answers = (await Promise.all(SHOWN.map((s, i) => shown(details[i], s.label, s.pick)))).filter((x): x is Shown => !!x);
  const picks = PICKS.map((id) => feeds.find((f) => f.id === id)).filter((f): f is FeedEntry => !!f);
  return (
    <Live initial={site}>
      <div className="hm-page">
      {/* One backdrop behind the whole page, so the sections read as one design and blend as you scroll. */}
      <div className="hm-sky" aria-hidden>
        <span className="hm-sky-dots" />
        <span className="hm-sky-lines" />
        <span className="hm-sky-shapes"><i /><i /><i /><i /><i /><i /></span>
        <span className="hm-sky-grain" />
      </div>
      <section className="hm-hero" id="live">
        <div className="hm-grid" aria-hidden />
        <div className="frame">
          <div className="hm-hero-in">
            <div className="hm-copy">
              <span className="eyebrow"><span className="beacon" /> The data terminal for AI agents</span>
              <h1 className="hm-h1">Robinhood Chain, as it happens.</h1>
              <p className="lede">New tokens, trades and signals, read from the chain block by block. Your agent buys them one answer at a time, from its own wallet, each one signed.</p>
              <div className="row">
                <Link className="btn" href="/feeds">Browse the feeds <ArrowRight /></Link>
                <Link className="btn ghost" href="/docs">Read the docs</Link>
              </div>
            </div>
            <Boundary label="The live panel could not be drawn.">
              <ChainPanel fires={signals?.recent ?? []} />
            </Boundary>
          </div>
        </div>
      </section>

      <section className="band hm-band hm-first" id="feeds">
        <div className="frame">
          <Reveal className="head hm-head">
            <span className="eyebrow">The catalog</span>
            <h2 className="h2">{feeds.length ? `${feeds.length} feeds, each with a price on it.` : "Feeds with a price on each."}</h2>
            <p className="lede">The chain first: launches, who sniped them, wallets that are early. Then stocks, filings and the economy.</p>
          </Reveal>
          {picks.length ? (
            <div className="feed-list">
              {picks.map((f, i) => (
                <Reveal key={f.id} delay={i % 3} style={{ display: "grid" }}>
                  <FeedRow f={f} />
                </Reveal>
              ))}
            </div>
          ) : (
            <div className="empty"><b>The catalog is loading</b>The engine publishes the list of feeds as soon as it is up.</div>
          )}
          <Reveal style={{ marginTop: 36 }}>
            <Link href="/feeds" className="btn ghost">See the whole catalog <ArrowRight /></Link>
          </Reveal>
        </div>
      </section>

      <section className="band hm-band" id="how">
        <div className="frame">
          <Reveal className="head hm-head">
            <span className="eyebrow">How it works</span>
            <h2 className="h2">Data your agent buys by the answer.</h2>
            <p className="lede">No account, no key, no plan. The price of a request is part of the conversation.</p>
          </Reveal>
          <div className="hm-how">
            <ol className="hm-steps">
              {STEPS.map(([t, d], i) => (
                <Reveal as="li" key={t} delay={i} className="hm-step">
                  <span className="hm-step-n num">{i + 1}</span>
                  <div>
                    <h3 className="h3">{t}</h3>
                    <p>{d}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
            <Boundary label="The live answer could not be drawn.">
              <Exchange answers={answers} />
            </Boundary>
          </div>
        </div>
      </section>

      <section className="band tight" id="developers">
        <div className="frame">
          <Reveal className="hm-dev">
            <div className="grid2" style={{ alignItems: "center" }}>
              <div className="stack" style={{ gap: 20 }}>
                <span className="chip" style={{ justifySelf: "start" }}>For developers</span>
                <h2 className="h2">Give your agent a terminal in five lines.</h2>
                <p className="lede">A TypeScript SDK that pays and verifies for you, an MCP server for any MCP client, and ready tools for the Vercel AI SDK, LangChain and ElizaOS.</p>
                <div className="row" style={{ marginTop: 8 }}>
                  <Link className="btn" href="/docs">Open the docs <ArrowRight /></Link>
                  <Link className="btn ghost" href="/docs#recipes">Agent recipes</Link>
                </div>
              </div>
              <CodeTabs tabs={[{ label: "SDK", code: SNIPPETS.sdk }, { label: "HTTP", code: SNIPPETS.curl }, { label: "MCP", code: SNIPPETS.mcp }, { label: "AI SDK", code: SNIPPETS.aisdk }]} />
            </div>
          </Reveal>
        </div>
      </section>

      <section className="band hm-band">
        <div className="frame">
          <Reveal className="hm-end">
            <h2 className="h2">Put a data terminal in your agent.</h2>
            <div className="row" style={{ justifyContent: "center" }}>
              <Link className="btn" href="/docs">Start with the docs <ArrowRight /></Link>
              <Link className="btn ghost" href="/terminal">Open the terminal</Link>
            </div>
          </Reveal>
        </div>
      </section>
      </div>
    </Live>
  );
}
