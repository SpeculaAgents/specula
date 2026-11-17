import type { Hex, LocalAccount } from "viem";
import { accessToken, decodeHeader, encodeHeader, signPayment, verifyAnswer, verifyInclusion, type Answer, type PaymentRequiredBody, type PaymentRequirements } from "./protocol.ts";

export * from "./protocol.ts";
export * from "./tools.ts";

export type Fresh = "live" | "recent" | "delayed";

export interface SpeculaOptions {
  /** Where the engine is. */
  baseUrl?: string;
  /** The wallet that pays and signs in. A viem local account (privateKeyToAccount, mnemonicToAccount). Optional: without one you get the anonymous free allowance only. */
  account?: LocalAccount;
  /** Refuse any single call that costs more than this, in USDG. Default 0.10. */
  maxPricePerCall?: string;
  /** Stop paying once this much was spent by this client, in USDG. Default: no limit. */
  budget?: string;
  /** Default freshness. "recent" and "delayed" cost less. */
  fresh?: Fresh;
  /** Check every answer's signature before returning it. Default true. */
  verify?: boolean;
  /** The engine address you trust. Default: learned from the engine on first use and pinned for the client's life. */
  engine?: string;
  fetch?: typeof fetch;
  /** A short name for your agent or framework, shown in the public request feed. */
  client?: string;
  /** The only token this client signs payments in. Default: USDG on Robinhood Chain. Set it for a local test chain. */
  payAsset?: string;
  /** The only network this client pays on, as "eip155:<chain id>". Default: any, with USDG required on Robinhood Chain. */
  network?: string;
}

/** USDG on Robinhood Chain: the one asset a default client agrees to sign for there. */
export const USDG_ROBINHOOD = { network: "eip155:4663", asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 } as const;

export class SpeculaError extends Error {
  constructor(public status: number, public code: string, message: string, public body: Record<string, unknown> = {}) {
    super(message);
    this.name = "SpeculaError";
  }
}

const units = (text: string, decimals = 6): bigint => {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a decimal amount: ${text}`);
  const [i, f = ""] = text.split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
};
const decimal = (u: bigint, decimals = 6) => {
  const s = u.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "") || "0";
};

export interface StreamHandle {
  close(): void;
  ready: Promise<void>;
}

export class Specula {
  readonly baseUrl: string;
  private opts: SpeculaOptions;
  private f: typeof fetch;
  private access: { value: string; expiry: number } | null = null;
  private pinned: string | null;
  private spentUnits = 0n;

  constructor(opts: SpeculaOptions = {}) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? "https://speculaagents.fun/api").replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.pinned = opts.engine?.toLowerCase() ?? null;
  }

  /** What this client has paid so far, in USDG. */
  get spent(): string {
    return decimal(this.spentUnits);
  }

  private async auth(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "X-Specula-Client": this.opts.client ?? "sdk" };
    if (!this.opts.account) return h;
    const now = Math.floor(Date.now() / 1000);
    if (!this.access || this.access.expiry < now + 60) this.access = { value: await accessToken(this.opts.account, 3600, now), expiry: now + 3600 };
    h.Authorization = `Specula ${this.access.value}`;
    return h;
  }

  /** One HTTP call that pays when asked to. A 402 is answered with a signed payment for exactly the amount asked. */
  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, pay = true): Promise<{ json: T; res: Response }> {
    const url = `${this.baseUrl}${path}`;
    const headers = { ...(await this.auth()), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    const init = { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
    let res = await this.f(url, init);
    if (res.status === 402 && pay) {
      const need = (await res.json()) as PaymentRequiredBody;
      const req = need.accepts?.[0];
      if (!req) throw new SpeculaError(402, need.error ?? "payment_required", "The engine asked for payment without saying how.", need as never);
      this.guard(req, need.error);
      const payment = await signPayment(this.opts.account!, req);
      res = await this.f(url, { ...init, headers: { ...headers, "X-PAYMENT": encodeHeader(payment) } });
      if (res.ok) this.spentUnits += BigInt(req.maxAmountRequired);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new SpeculaError(res.status, "bad_response", `The engine answered ${res.status} with something that is not JSON.`);
    }
    if (!res.ok) {
      const e = json as { error?: string; message?: string };
      throw new SpeculaError(res.status, e.error ?? "error", e.message ?? `The engine answered ${res.status}.`, json as never);
    }
    return { json: json as T, res };
  }

  private guard(req: PaymentRequirements, why?: string) {
    if (!this.opts.account) throw new SpeculaError(402, why ?? "payment_required", "This call needs payment and the client has no wallet. Pass { account } to pay per request.");
    // The limits below are dollars with six decimals. A request in another token, network or decimals is not signed:
    // the server could otherwise stretch maxPricePerCall by naming a token with more decimals.
    const asset = String(req.asset ?? "").toLowerCase();
    const wrongAsset =
      req.extra?.decimals !== USDG_ROBINHOOD.decimals ||
      (this.opts.payAsset !== undefined && asset !== this.opts.payAsset.toLowerCase()) ||
      (this.opts.network !== undefined && req.network !== this.opts.network) ||
      (req.network === USDG_ROBINHOOD.network && this.opts.payAsset === undefined && asset !== USDG_ROBINHOOD.asset);
    if (wrongAsset) throw new SpeculaError(402, "unexpected_asset", `This call asks for payment in ${req.asset} on ${req.network}, which this client does not pay in. Nothing was paid.`);
    const amount = BigInt(req.maxAmountRequired);
    const max = units(this.opts.maxPricePerCall ?? "0.10", USDG_ROBINHOOD.decimals);
    if (amount > max) throw new SpeculaError(402, "over_max_price", `This call costs ${decimal(amount)} USDG, above this client's maxPricePerCall of ${decimal(max)}. Nothing was paid.`);
    if (this.opts.budget !== undefined && this.spentUnits + amount > units(this.opts.budget, USDG_ROBINHOOD.decimals))
      throw new SpeculaError(402, "over_budget", `This call would pass this client's budget of ${this.opts.budget} USDG (spent ${this.spent}). Nothing was paid.`);
  }

  /** Ask any feed by id. The answer carries the data, where it came from, when it was collected, and the engine's signature. */
  async get<T = unknown>(feed: string, params: Record<string, string | number | undefined> = {}, opts: { fresh?: Fresh } = {}): Promise<Answer<T>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const fresh = opts.fresh ?? this.opts.fresh;
    if (fresh && fresh !== "live") q.set("fresh", fresh);
    const qs = q.toString();
    const { json } = await this.call<Answer<T>>("GET", `/v1/feeds/${feed}${qs ? `?${qs}` : ""}`);
    if (this.opts.verify !== false) {
      this.pinned ??= json.proof.engine.toLowerCase();
      if (!(await verifyAnswer(json, this.pinned))) throw new SpeculaError(502, "bad_signature", "The answer's signature does not match the engine. It was not returned.");
    }
    return json;
  }

  // ---- the chain
  price = (symbol: string, o?: { fresh?: Fresh }) => this.get("chain.price", { symbol }, o);
  prices = (kind: "all" | "equity" | "crypto" | "rate" = "all", o?: { fresh?: Fresh }) => this.get("chain.prices", { kind }, o);
  trades = (p: { token?: string; limit?: number } = {}, o?: { fresh?: Fresh }) => this.get("chain.trades", p, o);
  launches = (p: { limit?: number; buyers?: number } = {}, o?: { fresh?: Fresh }) => this.get("chain.launches", p, o);
  token = (token: string, o?: { fresh?: Fresh }) => this.get("chain.token", { token }, o);
  holders = (token: string, limit?: number, o?: { fresh?: Fresh }) => this.get("chain.holders", { token, limit }, o);
  liquidity = (p: { token?: string; pool?: string; limit?: number } = {}, o?: { fresh?: Fresh }) => this.get("chain.liquidity", p, o);
  wallet = (address: string, o?: { fresh?: Fresh }) => this.get("chain.wallet", { address }, o);
  fees = (token: string, o?: { fresh?: Fresh }) => this.get("chain.fees", { token }, o);
  // ---- companies
  filings = (ticker: string, p: { form?: string; limit?: number } = {}, o?: { fresh?: Fresh }) => this.get("sec.filings", { ticker, ...p }, o);
  events = (ticker: string, limit?: number, o?: { fresh?: Fresh }) => this.get("sec.events", { ticker, limit }, o);
  insiders = (ticker: string, limit?: number, o?: { fresh?: Fresh }) => this.get("sec.insiders", { ticker, limit }, o);
  holdings = (manager: string, limit?: number, o?: { fresh?: Fresh }) => this.get("sec.holdings", { manager, limit }, o);
  fundamentals = (ticker: string, o?: { fresh?: Fresh }) => this.get("sec.fundamentals", { ticker }, o);
  facts = (ticker: string, concept: string, limit?: number, o?: { fresh?: Fresh }) => this.get("sec.facts", { ticker, concept, limit }, o);
  summary = (ticker: string, p: { form?: string; accession?: string } = {}, o?: { fresh?: Fresh }) => this.get("sec.summary", { ticker, ...p }, o);
  // ---- the economy
  series = (series: string, limit?: number, o?: { fresh?: Fresh }) => this.get("macro.series", { series, limit }, o);
  economy = (o?: { fresh?: Fresh }) => this.get("macro.snapshot", {}, o);
  // ---- signals, answers, indexes
  signals = (p: { limit?: number; rule?: string } = {}, o?: { fresh?: Fresh }) => this.get("signals.recent", p, o);
  trackRecord = (o?: { fresh?: Fresh }) => this.get("signals.record", {}, o);
  ask = (q: string) => this.get<{ question: string; answered: boolean; answer: string; citations: { id: string; text: string; feed: string; source: string; collectedAt: string; digest: string }[] }>("answers.ask", { q });
  briefing = (day?: string) => this.get("answers.briefing", { day });
  index = (index: string, o?: { fresh?: Fresh }) => this.get("index.value", { index }, o);
  indexHistory = (index: string, limit?: number, o?: { fresh?: Fresh }) => this.get("index.history", { index, limit }, o);

  // ---- free reads
  private free = async <T>(path: string) => (await this.call<T>("GET", path, undefined, false)).json;
  catalog = () => this.free<{ count: number; feeds: { id: string; title: string; summary: string; params: { name: string; type: string; required?: boolean; doc: string; values?: string[] }[]; price: Record<string, { amount: string }>; example: Record<string, string> }[] }>("/v1/catalog");
  status = () => this.free<Record<string, unknown>>("/v1/status");
  quote = (feed: string) => this.free<Record<Fresh, { amount: string; list: string; level: number }>>(`/v1/quote/${feed}`);
  roots = () => this.free<{ roots: { hour: number; root: Hex }[] }>("/v1/roots");
  indexes = () => this.free<Record<string, unknown>>("/v1/indexes");
  oracleReport = (name: string) => this.free<{ id: Hex; value: string; timestamp: number; signature: Hex; signer: string }>(`/v1/oracle/${name}`);
  signalRules = () => this.free<{ rules: unknown[]; recent: unknown[] }>("/v1/signals");
  parseSignal = async (text: string) => (await this.call<{ understood: boolean; rule: unknown; reads: string | null }>("POST", "/v1/signals/parse", { text }, false)).json;

  // ---- the wallet's account
  account = () => this.free<{ wallet: string; credits: string; budget: { daily: string } | null; spentToday: string; spent30d: string; level: number; discountBps: number; allowance: { used: number; limit: number } }>("/v1/account");
  receipts = () => this.free<{ count: number; receipts: { id: string; kind: string; amount: string; transaction: string | null; feed: string | null; at: number }[] }>("/v1/receipts");
  /** Set a daily budget on the engine's side for this wallet, in USDG. Pass null to remove it. */
  setBudget = async (daily: string | null) => (await this.call<Record<string, unknown>>("POST", "/v1/budget", { daily }, false)).json;
  /** Prepay credits. Calls are then paid from the balance with no payment round trip, and streams can run. */
  topUp = async (amount: string) => {
    const before = this.opts.maxPricePerCall;
    this.opts.maxPricePerCall = amount; // a top-up is a deliberate larger payment
    try {
      return (await this.call<{ credits: string; receipt: { id: string; transaction: string } }>("POST", `/v1/credits/topup?amount=${amount}`)).json;
    } finally {
      this.opts.maxPricePerCall = before;
    }
  };
  /** Keep a signal rule. Say it in plain words, or pass a rule object. */
  addSignal = async (textOrRule: string | Record<string, unknown>) => (await this.call<{ id: string; name: string; rule: unknown }>("POST", "/v1/signals", typeof textOrRule === "string" ? { text: textOrRule } : { rule: textOrRule }, false)).json;
  removeSignal = async (id: string) => (await this.call<{ deleted: boolean }>("DELETE", `/v1/signals/${id}`, undefined, false)).json;
  mySignals = () => this.free<{ rules: { id: string; name: string }[] }>("/v1/signals/mine");

  // ---- marketplace, bounties, archive, lab, teams
  private write = async <T>(method: "POST" | "DELETE", path: string, body?: unknown) => (await this.call<T>(method, path, body, false)).json;
  market = () => this.free<{ count: number; feeds: { rank: number; id: string; title: string; price: string; seller: string; paid30d: string }[] }>("/v1/market");
  /** List a feed of your own: an https endpoint that returns JSON. Buyers pay your wallet directly. Pass allow to make it private. */
  listFeed = (f: { slug: string; title: string; summary: string; price: string; url: string; params?: { name: string; required?: boolean; doc?: string }[]; allow?: string[]; liveForSeconds?: number }) => this.write<{ id: string; private: boolean }>("POST", "/v1/market/feeds", f);
  unlistFeed = (slug: string) => this.write<{ removed: boolean }>("DELETE", `/v1/market/feeds/${slug}`);
  myFeeds = () => this.free<{ feeds: { id: string; paid30d: string }[]; earned30d: string }>("/v1/market/mine");
  bounties = () => this.free<{ open: number; bounties: { id: string; title: string; amount: string; status: string }[] }>("/v1/bounties");
  postBounty = (b: { title: string; detail: string; amount: string; days?: number }) => this.write<{ id: string; escrowId: Hex; status: string; fund: { contract: string | null; args?: string[] } }>("POST", "/v1/bounties", b);
  offerOnBounty = (id: string, feed: string) => this.write<{ id: string }>("POST", `/v1/bounties/${id}/offers`, { feed });
  /** A feed's answer as it was at a past moment, with its original signature. */
  asOf = (feed: string, params: Record<string, string | number> = {}, at?: string | number) => this.get<{ answer: Answer; ageAtThatTime: number }>("archive.at", { feed, params: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() || undefined, at: at === undefined ? undefined : String(at) });
  replay = (feed: string, params: Record<string, string | number> = {}, range: { from?: string | number; to?: string | number; limit?: number } = {}) => this.get<{ count: number; answers: Answer[] }>("archive.range", { feed, params: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() || undefined, from: range.from === undefined ? undefined : String(range.from), to: range.to === undefined ? undefined : String(range.to), limit: range.limit });
  backtest = (s: { symbol: string; direction?: "up" | "down"; bps: number; windowMin?: number; side?: "long" | "short"; sizeUsd?: number; holdMin?: number; takeBps?: number; stopBps?: number; days?: number }) => this.get<{ trades: number; pnlUsd: string; winShare: number | null; maxDrawdownUsd: string }>("lab.backtest", s);
  startPaperRun = (s: Record<string, string | number>) => this.write<{ id: string; reads: string }>("POST", "/v1/lab/paper", s);
  paperRuns = () => this.free<{ runs: { id: string; trades: number; pnlUsd: string }[] }>("/v1/lab/paper");
  stopPaperRun = (id: string) => this.write<{ stopped: boolean }>("DELETE", `/v1/lab/paper/${id}`);
  createTeam = (name: string, daily?: string) => this.write<{ id: string }>("POST", "/v1/teams", { name, daily });
  /** Invite a wallet to your team. It joins once that wallet calls joinTeam with the same team id. */
  addToTeam = (teamId: string, wallet: string) => this.write<{ id: string }>("POST", `/v1/teams/${teamId}/members`, { wallet });
  /** Accept an invite: this client's wallet joins the team, and the team's shared budget applies to it from then on. */
  joinTeam = (teamId: string) => this.write<{ id: string }>("POST", `/v1/teams/${teamId}/members`, { wallet: this.opts.account?.address });
  /** Leave a team this client's wallet is in. */
  leaveTeam = (teamId: string) => this.write<{ left: boolean }>("DELETE", `/v1/teams/${teamId}/members/${this.opts.account?.address}`);
  team = () => this.free<{ id: string; name: string; budget: { daily: string; spentToday: string } | null; members: { wallet: string; spent30d: string }[] }>("/v1/teams/mine");
  demand = () => this.free<{ calls: number; feeds: { rank: number; feed: string; calls7d: number }[] }>("/v1/demand");

  /** Check an answer yourself: its signature, and (once its hour is sealed) that it is inside the published hourly root. */
  async verify(answer: Answer, opts: { inclusion?: boolean } = {}): Promise<{ signature: boolean; inclusion: boolean | null; root: Hex | null; anchored: unknown }> {
    const signature = await verifyAnswer(answer, this.pinned ?? undefined);
    if (!opts.inclusion) return { signature, inclusion: null, root: null, anchored: null };
    const p = await this.free<{ sealed: boolean; proof?: Hex[]; root?: Hex; anchored?: unknown }>(`/v1/proof/${answer.proof.digest}`);
    if (!p.sealed || !p.proof || !p.root) return { signature, inclusion: null, root: null, anchored: null };
    return { signature, inclusion: verifyInclusion(answer.proof.digest, p.proof, p.root), root: p.root, anchored: p.anchored ?? null };
  }

  /** Live events over a websocket. Channels: prices, trades, launches, signals (metered by the minute) and requests (open). */
  stream(channels: string[], onEvent: (e: { channel: string; data: unknown; at: number }) => void, onNotice?: (m: Record<string, unknown>) => void): StreamHandle {
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/v1/stream`;
    let ws: WebSocket | null = null;
    let closed = false;
    let wake!: () => void;
    let fail!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => ((wake = res), (fail = rej)));
    void (async () => {
      const auth = this.opts.account ? (await this.auth()).Authorization?.replace(/^Specula /, "") : null;
      if (closed) return;
      ws = new WebSocket(auth ? `${wsUrl}?auth=${auth}` : wsUrl);
      ws.onopen = () => ws!.send(JSON.stringify({ op: "subscribe", channels }));
      ws.onerror = () => fail(new Error("could not open the stream"));
      let pending = new Set(channels);
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { op: string; channel?: string; data?: unknown; at?: number };
        if (msg.op === "event") return onEvent({ channel: msg.channel!, data: msg.data, at: msg.at! });
        if (msg.op === "subscribed" || msg.op === "paused" || msg.op === "error") {
          pending.delete(msg.channel ?? "");
          if (!pending.size) wake();
        }
        onNotice?.(msg as Record<string, unknown>);
      };
    })().catch(fail);
    return { ready, close: () => ((closed = true), ws?.close()) };
  }
}

export { decodeHeader };
