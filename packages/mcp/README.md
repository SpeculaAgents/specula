# @specula/mcp

Specula as an MCP server: one tool per data feed, each with its price in the description, paid per request from the
agent's own wallet. Without a key it works inside the free daily allowance and never pays.

```json
{ "mcpServers": { "specula": { "command": "npx", "args": ["-y", "@specula/mcp"],
  "env": { "SPECULA_AGENT_KEY": "0x...", "SPECULA_MAX_PRICE": "0.05", "SPECULA_BUDGET": "1.00" } } } }
```

Settings: `SPECULA_URL`, `SPECULA_AGENT_KEY` (optional), `SPECULA_MAX_PRICE` (default 0.05), `SPECULA_BUDGET`
(default 1.00), `SPECULA_FRESH` (`live`, `recent` or `delayed`). Specula is software, not financial advice.
