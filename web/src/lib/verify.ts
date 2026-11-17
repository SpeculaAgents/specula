// Checks an answer's signature in the browser, the same way the SDK does. Loaded only when someone runs a request.
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export async function checkSignature(a: { feed: string; params: unknown; data: unknown; source: string; collectedAt: number; proof: { engine: string; digest: string; signature: string } }): Promise<boolean> {
  const { keccak256, toBytes, recoverMessageAddress } = await import("viem");
  const digest = keccak256(toBytes(canonical({ feed: a.feed, params: a.params, data: a.data, source: a.source, collectedAt: a.collectedAt })));
  if (digest !== a.proof.digest) return false;
  const signer = await recoverMessageAddress({ message: { raw: digest }, signature: a.proof.signature as `0x${string}` }).catch(() => null);
  return !!signer && signer.toLowerCase() === a.proof.engine.toLowerCase();
}
