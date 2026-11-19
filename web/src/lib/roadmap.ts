import type { Indexes, Roots, Signals, Status } from "./types";

export type Stage = "live" | "part" | "built" | "next" | "later";
export const STAGE_LABEL: Record<Stage, string> = { live: "Live", part: "Partly live", built: "Built, not switched on", next: "Next", later: "Later" };

interface Seen {
  market?: { count: number } | null;
  bounties?: { escrow: string | null } | null;
  archive?: { answers: number } | null;
  lab?: { pricesRecorded: number } | null;
  demand?: { calls: number } | null;
  status: Status | null;
  signals: Signals | null;
  roots: Roots | null;
  indexes: Indexes | null;
}
interface Phase {
  n: string;
  title: string;
  text: string;
  /** Decided from what the running engine reports, never typed in by hand. */
  stage: (s: Seen) => Stage;
  note?: (s: Seen) => string | null;
}

const up = (s: Seen) => !!s.status?.ok;
const used = (s: Seen, group: string) => !!s.status?.feeds.some((f) => f.group === group && f.collections > 0);

export const PHASES: Phase[] = [
  { n: "01", title: "The site", text: "Landing page, feed catalog, runnable docs, status, changelog and this roadmap, all drawn from the running engine.", stage: () => "live" },
  { n: "02", title: "The data engine", text: "Many sources per feed with failover, one answer format, a hot cache, and every answer signed with its source and collection time.", stage: (s) => (up(s) ? "live" : "built") },
  { n: "03", title: "The chain market", text: "On-chain stock and crypto prices, DEX trades, liquidity events, holders and concentration, launches with first buyers, wallet profiles, fees and burns.", stage: (s) => (s.status?.index.block ? "live" : "built") },
  { n: "04", title: "Companies and the economy", text: "SEC filings parsed: the index, 8-K events, insider trades, fund holdings, reported numbers, summaries with paragraph links. Public statistics from the agencies that publish them.", stage: (s) => (used(s, "companies") || used(s, "economy") ? "live" : "built") },
  { n: "05", title: "Pay per request", text: "x402 payments in USDG, a free daily allowance, price by freshness, bulk levels, budgets, receipts and no charge for a failed answer.", stage: (s) => (s.status?.payments.on && s.status.payments.settles ? "live" : "built"), note: (s) => (s.status?.payments.on ? null : "Every answer is free until payments are switched on.") },
  { n: "06", title: "Agent access", text: "TypeScript SDK, MCP server, tools for the Vercel AI SDK, LangChain and ElizaOS, websocket streams and three agent recipes.", stage: () => "built", note: () => "The packages are in the repository and are not published to npm yet." },
  { n: "07", title: "The terminal", text: "The agent's view of the data in the browser: the price board, the trade tape, launches, signals and a command line.", stage: (s) => (up(s) ? "live" : "built") },
  { n: "08", title: "Signals", text: "Rules over the data that fire as events happen, your own rules in plain words, and a public track record of what the price did after each one.", stage: (s) => (s.signals?.rules.length ? "live" : "built") },
  { n: "09", title: "Ask the data", text: "Questions in plain words answered from live feeds with a citation on every sentence, and a daily briefing.", stage: (s) => (up(s) ? "live" : "built"), note: (s) => (s.status?.model === "standin" ? "Answers are written by the built-in rule model, which understands a fixed set of question shapes." : null) },
  { n: "10", title: "Verified data", text: "Every hour of signed answers sealed into one Merkle root, with a proof for any single answer, and the root posted on chain.", stage: (s) => (s.roots?.roots.some((r) => r.anchored) ? "live" : s.roots?.sealed ? "part" : "built"), note: (s) => (s.roots?.anchor ? null : "Roots are sealed and provable now. Posting them on chain starts when the anchor contract is deployed.") },
  { n: "11", title: "Quality scores", text: "A score per feed from measured uptime, speed, failovers and agreement between sources.", stage: (s) => (s.status?.feeds.some((f) => f.collections > 0) ? "live" : "built") },
  { n: "12", title: "Oracle and own indexes", text: "Specula's own indexes built from on-chain prices, and signed reports that any contract can read through the oracle.", stage: (s) => (s.indexes?.oracle.deployed ? "live" : s.indexes?.indexes.some((i) => i.value) ? "part" : "built"), note: (s) => (s.indexes?.oracle.deployed ? null : "Indexes and signed reports are live. The oracle contract is tested and not deployed yet.") },
  { n: "13", title: "Marketplace", text: "Anyone can sell a feed through Specula and is paid per call, straight to their wallet, ranked by what agents actually pay for.", stage: (s) => (s.market ? "live" : "built"), note: (s) => (s.market && !s.market.count ? "Open for listings. No seller has listed a feed yet." : null) },
  { n: "14", title: "Data bounties", text: "Ask for data that does not exist yet and fund it; the reward is held in escrow until a seller delivers.", stage: (s) => (s.bounties?.escrow ? "live" : s.bounties ? "part" : "built"), note: (s) => (s.bounties?.escrow ? null : "The board is open. The escrow contract is tested and not deployed, so a bounty is a pledge until it is.") },
  { n: "15", title: "Private feeds", text: "Feeds only chosen wallets can see or buy.", stage: (s) => (s.market ? "live" : "built") },
  { n: "16", title: "Archive and replay", text: "Every answer as it was at a past moment, with its signature, and the ability to replay a stretch of time.", stage: (s) => (s.archive?.answers ? "live" : "built") },
  { n: "17", title: "Strategy testing", text: "Run a strategy against recorded prices, then on live prices without money, before it trades.", stage: (s) => (s.lab?.pricesRecorded ? "live" : "built") },
  { n: "18", title: "Teams", text: "A shared daily budget and one report for a group of agent wallets.", stage: (s) => (up(s) ? "live" : "built") },
  { n: "19", title: "Phone app", text: "The terminal in your pocket.", stage: () => "part", note: () => "The site installs to a phone's home screen and opens like an app. There is no app in the stores." },
  { n: "20", title: "Partners and widgets", text: "Specula data inside other products, and widgets anyone can embed.", stage: () => "part", note: () => "A live price widget can be embedded today. No partner integrations yet." },
  { n: "21", title: "Public data index", text: "An open ranking of the data agents ask for most.", stage: (s) => (s.demand?.calls ? "live" : "built") },
  { n: "22", title: "Token", text: "The Specula token.", stage: () => "later" },
];

/** What comes after the build plan: the truth protocol. Plans, not live features; each says "the plan is" until it ships. */
export const AHEAD: { n: string; title: string; text: string }[] = [
  { n: "01", title: "The world model", text: "The plan is one live picture of the chain fused with the world behind it: filings, earnings, macro numbers and news, each with proof of its source, and a signed price for every stock token around the clock, including nights and weekends when Wall Street is closed." },
  { n: "02", title: "The agent census", text: "The plan is to identify every AI agent on the chain by how it behaves, not by what it claims, with its strategy fingerprinted and its record attached. The first map of the machine economy." },
  { n: "03", title: "The swarm", text: "The plan is thousands of simulated agents, each modelled on real wallets, playing the next hour out before it happens, so any agent can test a move against the crowd's most likely reaction." },
  { n: "04", title: "Self-learning forecasts", text: "The plan is forecasts graded against what really happened, in public, with models that retrain on their own mistakes every hour and every model version fingerprinted for good." },
  { n: "05", title: "Truth certificates", text: "The plan is a certificate of exactly what an agent knew when it acted, carried by every decision in any app, proposed as an open standard so apps, lenders and users can ask for it." },
  { n: "06", title: "The settlement layer", text: "The plan is for contracts, bets and deals between agents to settle against Specula's answer. Anyone who proves an answer wrong takes the stake behind it, and a reserve pays out on wrong verdicts." },
  { n: "07", title: "Specula runs itself", text: "The plan is for the engine to become an agent of its own: it earns from every answer, buys the data it is missing, pays sellers and node operators, and upgrades its models, all on chain." },
  { n: "08", title: "Owned by the network", text: "The plan is independent nodes in secure enclaves, answers that count only when a quorum signs them, a proof for every computation, holders who govern, and every fee in $SPECULA burned." },
];
