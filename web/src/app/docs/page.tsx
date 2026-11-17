import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/components/Code";
import { PageHead } from "@/components/PageHead";
import { Runner } from "@/components/Runner";
import { getCatalog } from "@/lib/engine";
import { SNIPPETS } from "@/lib/snippets";

export const metadata: Metadata = { title: "Docs", description: "How an agent asks Specula for data, pays per request and checks the answer. Every example on the page runs against the live engine." };

const NAV = [["start", "Quick start"], ["answer", "The answer"], ["paying", "Paying"], ["prices", "Prices and levels"], ["account", "Allowance, budgets, credits"], ["sdk", "SDK"], ["mcp", "MCP server"], ["tools", "Agent frameworks"], ["streams", "Streams"], ["signals", "Signals"], ["ask", "Ask the data"], ["verify", "Verifying"], ["oracle", "Indexes and oracle"], ["market", "Selling data"], ["archive", "Archive and lab"], ["teams", "Teams"], ["recipes", "Recipes"], ["errors", "Errors"]];

export default async function Docs() {
  const cat = await getCatalog();
  const free = cat?.freeDaily ?? { wallet: 100, anonymous: 25 };
  return (
    <>
      <PageHead crumb="Docs" title="Docs you can run">Every example with a Run button sends a real request to the live engine and shows exactly what comes back.</PageHead>
      <section className="section">
        <div className="frame docs">
          <nav className="docs-nav" aria-label="On this page">
            {NAV.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
          </nav>
          <div>
            <article className="doc" id="start">
              <h2>Quick start</h2>
              <p>Specula is an HTTP API. There is no sign-up and no key. Ask for a feed by its id and you get a signed answer.</p>
              <Runner path="/v1/feeds/chain.price" params={[{ name: "symbol", type: "symbol", required: true, doc: "" }]} initial={{ symbol: "ETH" }} />
              <p>The full list of feeds, with parameters and prices, is one request away. The <Link className="link" href="/feeds">catalog page</Link> is drawn from the same list.</p>
              <Runner path="/v1/catalog" />
              <p>In code, the SDK does the asking, the paying and the checking:</p>
              <Code>{`npm install @specula/sdk viem`}</Code>
              <Code>{SNIPPETS.sdk}</Code>
            </article>

            <article className="doc" id="answer">
              <h2>The answer</h2>
              <p>Every feed answers in the same shape, whatever its source.</p>
              <ul>
                <li><span className="inline">data</span> the answer itself.</li>
                <li><span className="inline">source</span> which source answered, and <span className="inline">meta.tried</span> every source that was tried on the way.</li>
                <li><span className="inline">collectedAt</span> when the data was collected, in unix seconds. <span className="inline">meta.ageSeconds</span> says how old it was when served.</li>
                <li><span className="inline">meta.price</span> what was charged, and <span className="inline">meta.paidBy</span> how: free allowance, x402 or credits.</li>
                <li><span className="inline">proof</span> the engine&apos;s address, the digest of the answer and the signature over it.</li>
              </ul>
              <p>The signature covers the feed, the parameters, the data, the source and the collection time together, so none of them can be changed afterwards.</p>
            </article>

            <article className="doc" id="paying">
              <h2>Paying</h2>
              <p>Payment uses x402, the HTTP way of paying for a request. When a call needs payment the engine answers <span className="inline">402</span> and says exactly what it wants:</p>
              <Code>{`{
  "x402Version": 1,
  "error": "free_allowance_used",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:4663",
    "maxAmountRequired": "1000",          // base units: 0.001 USDG
    "asset": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "payTo": "0x...",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "Global Dollar", "version": "1", "decimals": 6, "symbol": "USDG" }
  }]
}`}</Code>
              <p>The agent signs a one-time transfer of exactly that amount to that address (EIP-3009, <span className="inline">transferWithAuthorization</span>) and sends the request again with the signature in an <span className="inline">X-PAYMENT</span> header. The signature can move that amount once, to that address, before it expires. It cannot be reused or changed.</p>
              <p>The engine checks the payment, collects the answer, and only then settles the payment on chain. If no source can answer, nothing is settled and the reply says <span className="inline">&quot;charged&quot;: false</span>.</p>
              <p>What a call costs right now, for you:</p>
              <Runner path="/v1/quote/chain.price" />
            </article>

            <article className="doc" id="prices">
              <h2>Prices and levels</h2>
              <p>Each feed has a price for a live answer. Add <span className="inline">fresh=recent</span> to accept an answer up to five minutes old for half the price, or <span className="inline">fresh=delayed</span> for one up to an hour old at a fifth.</p>
              <Runner path="/v1/feeds/macro.series" params={[{ name: "series", type: "enum", values: ["cpi", "unemployment", "payrolls", "public_debt", "yield_10y", "yield_2y"], required: true, doc: "" }, { name: "fresh", type: "enum", values: ["live", "recent", "delayed"], default: "live", doc: "" }]} initial={{ series: "yield_10y", fresh: "delayed" }} />
              <p>Wallets that buy more pay less. What a wallet paid over the last 30 days sets its level: 10 USDG gives 10% off, 100 gives 20%, 1,000 gives 30%.</p>
            </article>

            <article className="doc" id="account">
              <h2>Allowance, budgets, credits</h2>
              <p>Every wallet gets {free.wallet} free calls a day, and a caller without a wallet gets {free.anonymous}. A wallet identifies itself by signing one readable line, which the SDK does for you:</p>
              <Code>{`Authorization: Specula <address>.<expiry>.<signature>
// the signed line reads: "Specula access for 0xabc... until 1794900000"`}</Code>
              <ul>
                <li><span className="inline">GET /v1/account</span> shows the allowance used, the level, credits and spend.</li>
                <li><span className="inline">POST /v1/budget</span> with <span className="inline">{`{"daily": "2.50"}`}</span> sets a daily limit. A call that would pass it is refused before anything is charged.</li>
                <li><span className="inline">POST /v1/credits/topup?amount=5</span> prepays credits with one payment. Calls are then paid from the balance with no round trip.</li>
                <li><span className="inline">GET /v1/receipts</span> lists a signed receipt for every payment, with its transaction.</li>
              </ul>
              <Code>{`await specula.setBudget("2.50");
await specula.topUp("5");
console.log(await specula.account(), await specula.receipts());`}</Code>
            </article>

            <article className="doc" id="sdk">
              <h2>SDK</h2>
              <p><span className="inline">@specula/sdk</span> is a small TypeScript client. It signs in, answers a 402 with a signed payment, refuses to pay more than you allow, and checks every answer&apos;s signature before returning it.</p>
              <Code>{`const specula = new Specula({ account, maxPricePerCall: "0.05", budget: "2.00", fresh: "recent" });

await specula.price("NVDA");                 // chain.price
await specula.trades({ limit: 20 });         // chain.trades
await specula.launches({ buyers: 10 });      // chain.launches
await specula.holders("0x...token");         // chain.holders
await specula.wallet("0x...address");        // chain.wallet
await specula.events("TSLA");                // sec.events
await specula.insiders("NVDA");              // sec.insiders
await specula.holdings("BRK-B");             // sec.holdings
await specula.fundamentals("AAPL");          // sec.fundamentals
await specula.summary("NVDA", { form: "8-K" });
await specula.economy();                     // macro.snapshot
await specula.get("any.feed", { any: "param" });`}</Code>
            </article>

            <article className="doc" id="mcp">
              <h2>MCP server</h2>
              <p><span className="inline">@specula/mcp</span> gives any MCP client one tool per feed, each with its price in the description, plus tools to see the account and to ask a question. Without a key it uses the free allowance.</p>
              <Code>{SNIPPETS.mcp}</Code>
            </article>

            <article className="doc" id="tools">
              <h2>Agent frameworks</h2>
              <p>The same feeds as ready tools. Each tool&apos;s description carries its price, so a model can weigh cost before it calls.</p>
              <h3>Vercel AI SDK</h3>
              <Code>{SNIPPETS.aisdk}</Code>
              <h3>LangChain</h3>
              <Code>{SNIPPETS.langchain}</Code>
              <h3>ElizaOS</h3>
              <Code>{`import { speculaPlugin } from "@specula/plugin-eliza";

export const character = { name: "Analyst", plugins: [speculaPlugin] };
// settings: SPECULA_AGENT_KEY, SPECULA_MAX_PRICE, SPECULA_BUDGET`}</Code>
            </article>

            <article className="doc" id="streams">
              <h2>Streams</h2>
              <p>A websocket at <span className="inline">/v1/stream</span> pushes events as they happen. The <span className="inline">requests</span> channel is open. <span className="inline">prices</span>, <span className="inline">trades</span>, <span className="inline">launches</span> and <span className="inline">signals</span> are metered by the minute: each minute uses one free call, then 0.0005 USDG from credits. A channel that cannot pay is paused and says why.</p>
              <Code>{SNIPPETS.stream}</Code>
              <Code>{`> {"op":"subscribe","channels":["prices","trades"]}
< {"op":"subscribed","channel":"prices","paidBy":"free","pricePerMinute":"0.0005"}
< {"op":"event","channel":"prices","data":[{"symbol":"NVDA","price":"156.52"}],"at":1794864936}`}</Code>
            </article>

            <article className="doc" id="signals">
              <h2>Signals</h2>
              <p>Signals are rules over the data. The built-in ones are public with their track record on the <Link className="link" href="/signals">signals page</Link>. A wallet can keep its own rules, written in plain words. Try a sentence:</p>
              <Runner path="/v1/signals/parse" method="POST" body={`{"text": "tell me when NVDA falls 3% in an hour"}`} />
              <Code>{`const rule = await specula.addSignal("a buy over $10k on the DEX");
specula.stream(["signals"], (e) => console.log(e.data));`}</Code>
            </article>

            <article className="doc" id="ask">
              <h2>Ask the data</h2>
              <p>One feed takes a question instead of parameters. It picks the feeds that can answer, collects them, and writes an answer in which every sentence cites the signed answer it came from.</p>
              <Runner path="/v1/feeds/answers.ask" params={[{ name: "q", type: "string", required: true, doc: "" }]} initial={{ q: "What is ETH trading at, and how is inflation?" }} />
            </article>

            <article className="doc" id="verify">
              <h2>Verifying</h2>
              <p>To check an answer yourself: write <span className="inline">feed, params, data, source, collectedAt</span> as JSON with keys sorted and no spaces, hash it with keccak256, and recover the signer of that hash from the signature (an Ethereum signed message). It must be the engine&apos;s address.</p>
              <p>Each hour, everything the engine signed is sealed into one Merkle root. Ask for the proof of any answer by its digest:</p>
              <Runner path="/v1/roots" />
              <Code>{SNIPPETS.verify}</Code>
            </article>

            <article className="doc" id="oracle">
              <h2>Indexes and oracle</h2>
              <p>Specula computes its own indexes from on-chain prices. Any index or price is also available as a signed report that a smart contract can check by itself: whoever carries the report on chain does not need to be trusted.</p>
              <Runner path="/v1/oracle/index:ai" />
              <Code>{`// Solidity, with the oracle contract
int256 value = oracle.read(bytes32("index:ai"), 1 hours); // reverts if older than an hour`}</Code>
            </article>

            <article className="doc" id="market">
              <h2>Selling data</h2>
              <p>Any wallet can list a feed on the <Link className="link" href="/market">marketplace</Link>: a public https endpoint that returns JSON, with a price per call. Buyers pay the seller&apos;s wallet directly; a seller&apos;s feed has no free allowance. If the endpoint fails, the buyer is not charged.</p>
              <Code>{`await specula.listFeed({ slug: "weather", title: "City weather now",
  summary: "Temperature and wind for a city, from a station network.",
  price: "0.25", url: "https://api.example.com/weather",
  params: [{ name: "city", required: true }] });
await specula.myFeeds();                       // paid calls and what was earned`}</Code>
              <p>Add <span className="inline">allow: [wallets]</span> and the feed is private: it exists only for those wallets. To ask for data nobody sells yet, post a bounty with <span className="inline">specula.postBounty()</span> and fund it in the escrow contract.</p>
              <Runner path="/v1/market" />
            </article>

            <article className="doc" id="archive">
              <h2>Archive and lab</h2>
              <p>The archive keeps answers as they were collected, each with its original signature. <span className="inline">archive.at</span> returns what a feed said at a moment; <span className="inline">archive.range</span> replays a stretch of time.</p>
              <Runner path="/v1/feeds/archive.at" params={[{ name: "feed", type: "string", required: true, doc: "" }, { name: "params", type: "string", doc: "" }, { name: "at", type: "string", doc: "" }]} initial={{ feed: "chain.prices", params: "kind=all" }} />
              <p>The <Link className="link" href="/lab">lab</Link> runs a simple entry and exit rule over recorded prices, and can keep running it on live prices with pretend money.</p>
              <Code>{`await specula.backtest({ symbol: "ETH", direction: "down", bps: 50, holdMin: 120 });
await specula.startPaperRun({ symbol: "ETH", direction: "down", bps: 50, holdMin: 120 });`}</Code>
            </article>

            <article className="doc" id="teams">
              <h2>Teams</h2>
              <p>A team is one owner, many agent wallets and one shared daily budget. A wallet joins only by accepting an invite with its own signature, and can leave at any time. A call that would take the team past its budget is refused before anything is charged, and the owner gets one report of who spent what.</p>
              <Code>{`const team = await specula.createTeam("Desk one", "5.00"); // 5 USDG a day, shared
await specula.addToTeam(team.id, "0x...agent"); // an invite
await agentClient.joinTeam(team.id); // the agent's own wallet accepts it
console.log(await specula.team());`}</Code>
              <p>A live price can also be put on any page as a widget: <span className="inline">{`<iframe src="https://speculaagents.fun/embed/price/NVDA">`}</span>.</p>
            </article>

            <article className="doc" id="recipes">
              <h2>Recipes</h2>
              <p>Three small agents in the repository, each a single file you can run:</p>
              <ul>
                <li><b>Launch watcher.</b> Streams new launches, reads the first buyers and the deployer&apos;s history, and writes a short note on each.</li>
                <li><b>Filing reader.</b> Watches a list of companies for new 8-K events and insider trades, and summarises each with links to the paragraph.</li>
                <li><b>Morning desk.</b> Once a day, spends a fixed budget on the price board, the economy snapshot and the briefing, and prints one page.</li>
              </ul>
              <Code>{`cd packages && npm install && cd recipes
SPECULA_URL=http://localhost:4100 npx tsx launch-watcher.ts`}</Code>
            </article>

            <article className="doc" id="errors">
              <h2>Errors</h2>
              <p>Errors are JSON with a short <span className="inline">error</span> code and a plain <span className="inline">message</span>.</p>
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Status</th><th>Code</th><th>Meaning</th></tr></thead>
                  <tbody>
                    {[
                      ["400", "missing_param, bad_param", "The request is wrong. The message says which parameter."],
                      ["402", "free_allowance_used", "Pay the amount in accepts[0] and ask again."],
                      ["402", "amount_too_low, bad_signature, ...", "The payment was not accepted. Nothing was charged."],
                      ["403", "budget_reached", "The wallet's own daily budget would be passed."],
                      ["404", "unknown_feed, unknown_symbol, ...", "There is no such thing to ask about."],
                      ["409", "indexing", "The engine is reading history for this request. Ask again shortly."],
                      ["502", "all_sources_failed", "No source could answer. Nothing was charged."],
                    ].map(([s, c, m]) => (
                      <tr key={c}><td className="id">{s}</td><td className="id">{c}</td><td>{m}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </div>
        </div>
      </section>
    </>
  );
}
