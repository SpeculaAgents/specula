import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { feedTools, Specula, SpeculaError, type FeedTool, type SpeculaOptions } from "@specula/sdk";

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError });

/**
 * Specula as an MCP server. One tool per feed, built from the live catalog, each with its price in the description;
 * plus the wallet's account and the catalog itself. Paid calls stay inside the limits the SDK client was given.
 */
export async function makeServer(opts: SpeculaOptions = {}) {
  const specula = new Specula({ client: "mcp", ...opts });
  let tools: FeedTool[] | null = null;
  const load = async () => (tools ??= await feedTools(specula));
  const extra = [
    { name: "specula_account", description: "This agent's Specula account: free calls used today, bulk level, prepaid credits and what it has spent. Free.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "specula_catalog", description: "The list of Specula feeds with what each answers and costs. Free.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ];
  const server = new Server({ name: "specula", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...(await load()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })), ...extra] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "specula_catalog") return text((await specula.catalog()).feeds.map((f) => ({ id: f.id, title: f.title, summary: f.summary, price: f.price.live.amount })));
      if (name === "specula_account") {
        if (!opts.account) return text({ wallet: null, note: "No wallet is configured, so this agent uses the anonymous free allowance and cannot pay past it.", spentByThisSession: specula.spent });
        return text({ ...(await specula.account()), spentByThisSession: specula.spent });
      }
      const tool = (await load()).find((t) => t.name === name);
      if (!tool) return text(`Unknown tool "${name}".`, true);
      return text(await tool.run((args ?? {}) as Record<string, unknown>));
    } catch (e) {
      // A refusal to pay is information for the model, not a crash: say what happened and what it would cost.
      if (e instanceof SpeculaError) return text({ error: e.code, message: e.message, status: e.status }, true);
      return text(`The request failed: ${(e as Error).message}`, true);
    }
  });
  return { server, specula };
}
