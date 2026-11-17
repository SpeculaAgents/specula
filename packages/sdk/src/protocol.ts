import { keccak256, recoverMessageAddress, toBytes, toHex, type Address, type Hex, type LocalAccount } from "viem";

/** What the engine asks for when a request needs payment (x402, scheme "exact"). */
export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: { name: string; version: string; decimals: number; symbol: string };
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/** What the agent sends back in the X-PAYMENT header: a signed transfer authorization (EIP-3009). */
export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: { signature: Hex; authorization: Authorization };
}

export interface PaymentRequiredBody {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirements[];
}

export const chainIdOf = (network: string) => Number(network.replace(/^eip155:/, ""));

export const authorizationTypedData = (chainId: number, asset: Address, name: string, version: string, a: Authorization) =>
  ({
    domain: { name, version, chainId, verifyingContract: asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
  }) as const;

const b64 = {
  enc: (s: string) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64")),
  dec: (s: string) => (typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8")),
};
export const encodeHeader = (v: unknown) => b64.enc(JSON.stringify(v));
export const decodeHeader = <T>(s: string): T => JSON.parse(b64.dec(s)) as T;

/** Sign a payment for exactly what was asked. The signature moves that amount once, to that address, and expires. */
export async function signPayment(account: LocalAccount, req: PaymentRequirements, nowSec = Math.floor(Date.now() / 1000)): Promise<PaymentPayload> {
  const rand = new Uint8Array(32);
  crypto.getRandomValues(rand);
  const authorization: Authorization = {
    from: account.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: "0",
    validBefore: String(nowSec + Math.max(30, req.maxTimeoutSeconds)),
    nonce: toHex(rand),
  };
  const signature = await account.signTypedData(authorizationTypedData(chainIdOf(req.network), req.asset, req.extra.name, req.extra.version, authorization));
  return { x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } };
}

/** The line a wallet signs to identify itself for the free allowance, credits and budgets. Readable on purpose. */
export const accessMessage = (address: string, expiry: number) => `Specula access for ${address.toLowerCase()} until ${expiry}`;
export async function accessToken(account: LocalAccount, ttlSec = 3600, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const expiry = nowSec + ttlSec;
  const signature = await account.signMessage({ message: accessMessage(account.address, expiry) });
  return `${account.address.toLowerCase()}.${expiry}.${signature}`;
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export interface Answer<T = unknown> {
  feed: string;
  params: Record<string, string>;
  data: T;
  source: string;
  collectedAt: number;
  meta: {
    collectedAtIso: string;
    servedAt: string;
    ageSeconds: number;
    tier: "live" | "recent" | "delayed";
    cached: boolean;
    tried: { source: string; ok: boolean; ms: number; error?: string }[];
    requestId: string;
    price: { amount: string; units: string; asset: string; listAmount: string; level: number };
    paidBy: "free" | "x402" | "credits";
    receipt: string | null;
    transaction: string | null;
    allowance: { used: number; limit: number | null };
  };
  proof: { engine: Address; alg: string; digest: Hex; signature: Hex };
}

export const answerDigest = (a: Pick<Answer, "feed" | "params" | "data" | "source" | "collectedAt">): Hex =>
  keccak256(toBytes(canonical({ feed: a.feed, params: a.params, data: a.data, source: a.source, collectedAt: a.collectedAt })));

/** Check an answer's signature. Pass the engine address you trust; without one it checks against the address in the answer. */
export async function verifyAnswer(a: Answer, engine?: string): Promise<boolean> {
  const digest = answerDigest(a);
  if (digest !== a.proof.digest) return false;
  const signer = await recoverMessageAddress({ message: { raw: digest }, signature: a.proof.signature }).catch(() => null);
  return !!signer && signer.toLowerCase() === (engine ?? a.proof.engine).toLowerCase();
}

/** Check a Merkle proof for an answer's digest against a published hourly root (sorted pairs, keccak256). */
export function verifyInclusion(digest: Hex, proof: Hex[], root: Hex): boolean {
  let h = digest.toLowerCase() as Hex;
  for (const p of proof) {
    const [a, b] = h.toLowerCase() < p.toLowerCase() ? [h, p] : [p, h];
    h = keccak256(`0x${a.slice(2)}${b.slice(2)}` as Hex);
  }
  return h.toLowerCase() === root.toLowerCase();
}
