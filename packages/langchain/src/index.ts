import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { feedTools, Specula, SpeculaError, type SpeculaOptions, type ToolOptions } from "@specula/sdk";

/** Specula feeds as LangChain tools, one per feed, built from the live catalog. */
export async function speculaToolkit(opts: SpeculaOptions & ToolOptions & { specula?: Specula } = {}): Promise<DynamicStructuredTool[]> {
  const specula = opts.specula ?? new Specula({ client: "langchain", ...opts });
  return (await feedTools(specula, opts)).map((t) => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, p] of Object.entries(t.schema.properties)) {
      let s: z.ZodTypeAny = p.enum ? z.enum(p.enum as [string, ...string[]]) : p.type === "integer" ? z.union([z.number().int(), z.string()]) : z.string();
      s = s.describe(p.description);
      shape[name] = t.schema.required.includes(name) ? s : s.optional();
    }
    return new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: z.object(shape),
      func: async (args: Record<string, unknown>) => {
        try {
          return JSON.stringify(await t.run(args));
        } catch (e) {
          if (e instanceof SpeculaError) return JSON.stringify({ error: e.code, message: e.message });
          throw e;
        }
      },
    });
  });
}
