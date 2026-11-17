import { jsonSchema, tool, type ToolSet } from "ai";
import { feedTools, Specula, SpeculaError, type SpeculaOptions, type ToolOptions } from "@specula/sdk";

/**
 * Specula feeds as Vercel AI SDK tools. Each tool's description states its price; the client's maxPricePerCall and
 * budget are hard limits, and a call that would pass them comes back to the model as a plain refusal.
 */
export async function speculaTools(opts: SpeculaOptions & ToolOptions & { specula?: Specula } = {}): Promise<ToolSet> {
  const specula = opts.specula ?? new Specula({ client: "ai-sdk", ...opts });
  const out: ToolSet = {};
  for (const t of await feedTools(specula, opts))
    out[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema<Record<string, unknown>>(t.schema as never),
      execute: async (args) => {
        try {
          return await t.run(args);
        } catch (e) {
          if (e instanceof SpeculaError) return { error: e.code, message: e.message };
          throw e;
        }
      },
    });
  return out;
}
