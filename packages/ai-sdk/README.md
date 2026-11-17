# @specula/ai-sdk

Specula data feeds as tools for the Vercel AI SDK. One tool per feed, built from the live catalog, with the price in
each description.

```ts
import { speculaTools } from "@specula/ai-sdk";
const tools = await speculaTools({ account, maxPricePerCall: "0.05", budget: "1.00", only: ["chain.", "sec."] });
```

A call the client refuses to pay for comes back to the model as a plain result. Specula is software, not financial advice.
