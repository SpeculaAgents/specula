# @specula/sdk

Specula is a data terminal for AI agents. An agent asks for the data it needs, pays for that one answer from its own
wallet, and gets it back signed.

```ts
import { Specula } from "@specula/sdk";
import { privateKeyToAccount } from "viem/accounts";

const specula = new Specula({
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`), // optional: without it you get the free allowance
  maxPricePerCall: "0.05", // never pay more than this for one answer
  budget: "2.00",          // stop paying after this much
});

const nvda = await specula.price("NVDA");
console.log(nvda.data.price, nvda.source, nvda.meta.collectedAtIso, nvda.meta.price.amount);

const events = await specula.events("TSLA");            // 8-K events, decoded
const who = await specula.holders("0x...token");        // holders and concentration
const cheap = await specula.economy({ fresh: "delayed" }); // up to an hour old, a fifth of the price
```

What happens on a paid call: the engine answers `402` with the exact amount, the SDK signs a one-time transfer of that
amount (EIP-3009, USDG) and sends the request again. The engine collects the answer first and only then settles the
payment, so a failed answer is never charged. Every answer is checked against the engine's signature before it is
returned.

- `specula.get(feed, params, { fresh })` reaches any feed in the catalog (`specula.catalog()`).
- `specula.account()`, `specula.receipts()`, `specula.setBudget("2.50")`, `specula.topUp("5")`.
- `specula.stream(["prices", "trades"], onEvent)` for live events.
- `specula.addSignal("tell me when NVDA falls 3% in an hour")`.
- `specula.verify(answer, { inclusion: true })` checks the signature and the hourly Merkle proof.

Specula is software, not financial advice. Use at your own risk.
