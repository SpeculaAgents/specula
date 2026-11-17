import { keccak256, recoverMessageAddress, toBytes, type Hex } from "viem";
import type { Ctx } from "./ctx.ts";
import { canonical, sameAddress } from "./util.ts";

export const SIGN_ALG = "eip191(keccak256(canonical-json))";

/** The digest of any value: keccak256 over its canonical JSON bytes. */
export const digestOf = (value: unknown): Hex => keccak256(toBytes(canonical(value)));

export async function signValue(ctx: Ctx, value: unknown): Promise<{ digest: Hex; signature: Hex }> {
  const digest = digestOf(value);
  const signature = await ctx.signer.signMessage({ message: { raw: digest } });
  return { digest, signature };
}

export async function verifyValue(value: unknown, signature: Hex, engine: string): Promise<boolean> {
  const signer = await recoverMessageAddress({ message: { raw: digestOf(value) }, signature }).catch(() => null);
  return sameAddress(signer, engine);
}
