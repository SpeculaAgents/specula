// Answers that agree across sources. A price feed with two independent sources asks both every time, compares the
// readings, drops a source that is stale, frozen or out of line, and says what it did in the answer. When too few
// sources agree, the feed says so instead of answering.

/** One source's reading of one thing. `value` and `at` are what is compared; `mark` identifies the round. */
export interface Reading {
  key: string;
  value: number;
  /** When the source says the value was set, in seconds. */
  at: number;
  /** How long a reading may go without an update before it counts as stale, in seconds. */
  heartbeat: number;
}

export interface AgreeRule {
  /** Two readings agree when they are within this many basis points of their middle. */
  toleranceBps: number;
  /** A source is stale when it is past its heartbeat and this many seconds behind the freshest source. */
  maxLagSec: number;
  /** A source is frozen when its time moved this many times in a row and its value never did, while another source's value moved. */
  frozenAfter: number;
  /** The readings in one source's answer. */
  read(data: unknown): Reading[];
  /**
   * Build the answer from what the sources said and the verdicts: keep what agreed, leave out what did not, say
   * what happened. Returns the data and the source it is mainly taken from, or throws when nothing can be given out.
   */
  merge(answers: { source: string; data: unknown }[], verdicts: Map<string, Verdict>, summary: Summary): { data: unknown; source: string };
}

export type Fault = "stale" | "frozen" | "disagrees";
export interface Dropped {
  source: string;
  reason: Fault;
  /** What the source said and how far it was from the others, in plain numbers. */
  value: number;
  at: number;
  offBps: number | null;
}
export interface Verdict {
  key: string;
  /** Sources that have this reading at all. */
  sources: number;
  /** Sources left after the faulty ones were dropped, all within tolerance of each other. */
  agreed: number;
  agreedSources: string[];
  /** Widest gap between two agreeing sources, in basis points. Null with one source. */
  spreadBps: number | null;
  dropped: Dropped[];
  /** True when the reading can be given out. */
  ok: boolean;
  /** Why it cannot, when it cannot. */
  why: string | null;
}
export interface Summary {
  toleranceBps: number;
  /** Sources the feed has. */
  sourcesKnown: number;
  /** Sources that answered this time. */
  sourcesAnswered: number;
  unreachable: string[];
}

const gapBps = (a: number, b: number) => {
  const mid = (Math.abs(a) + Math.abs(b)) / 2;
  return mid === 0 ? 0 : Math.round((Math.abs(a - b) / mid) * 10000);
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** What each source said the last few times, so a value that stopped moving can be told from one that is simply calm. */
export type History = Map<string, { at: number; value: number }[]>;

function isFrozen(hist: History, source: string, key: string, others: string[], rule: Pick<AgreeRule, "frozenAfter">): boolean {
  const mine = hist.get(`${source}|${key}`) ?? [];
  if (mine.length < rule.frozenAfter + 1) return false;
  const tail = mine.slice(-(rule.frozenAfter + 1));
  const timeMoved = tail.every((p, i) => i === 0 || p.at > tail[i - 1].at);
  const valueStuck = tail.every((p) => p.value === tail[0].value);
  if (!timeMoved || !valueStuck) return false;
  // Frozen only if somebody else saw the value move over the same stretch.
  return others.some((o) => {
    const theirs = (hist.get(`${o}|${key}`) ?? []).filter((p) => p.at >= tail[0].at);
    return theirs.length >= 2 && theirs.some((p) => gapBps(p.value, theirs[0].value) > 0);
  });
}

/**
 * Compare what the sources said. `answers` holds one entry per source that answered, in the feed's own order.
 * Pure apart from `hist`, which it appends to.
 */
export function reconcile(answers: { source: string; readings: Reading[] }[], rule: Pick<AgreeRule, "toleranceBps" | "maxLagSec" | "frozenAfter">, hist: History): Map<string, Verdict> {
  const byKey = new Map<string, { source: string; r: Reading }[]>();
  for (const a of answers)
    for (const r of a.readings) {
      const list = byKey.get(r.key) ?? [];
      list.push({ source: a.source, r });
      byKey.set(r.key, list);
      const h = hist.get(`${a.source}|${r.key}`) ?? [];
      const last = h[h.length - 1];
      if (!last || last.at !== r.at || last.value !== r.value) h.push({ at: r.at, value: r.value });
      hist.set(`${a.source}|${r.key}`, h.slice(-12));
    }
  const out = new Map<string, Verdict>();
  for (const [key, all] of byKey) {
    const dropped: Dropped[] = [];
    const freshest = Math.max(...all.map((x) => x.r.at));
    let live = all.filter((x) => {
      const others = all.filter((o) => o !== x);
      const lag = freshest - x.r.at;
      // Stale: past its own heartbeat while another source is not, or far behind a source that has moved on.
      const pastHeartbeat = others.some((o) => freshest - o.r.at <= o.r.heartbeat) && lag > x.r.heartbeat;
      if (others.length && (pastHeartbeat || (lag > rule.maxLagSec && lag > x.r.heartbeat / 2))) {
        dropped.push({ source: x.source, reason: "stale", value: x.r.value, at: x.r.at, offBps: null });
        return false;
      }
      if (others.length && isFrozen(hist, x.source, key, others.map((o) => o.source), rule)) {
        dropped.push({ source: x.source, reason: "frozen", value: x.r.value, at: x.r.at, offBps: null });
        return false;
      }
      return true;
    });
    // With three or more left, the middle value decides who is out of line. With two, nobody can tell which one is.
    if (live.length >= 3) {
      const mid = median(live.map((x) => x.r.value));
      live = live.filter((x) => {
        const off = gapBps(x.r.value, mid);
        if (off <= rule.toleranceBps) return true;
        dropped.push({ source: x.source, reason: "disagrees", value: x.r.value, at: x.r.at, offBps: off });
        return false;
      });
    }
    let spread: number | null = null;
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) spread = Math.max(spread ?? 0, gapBps(live[i].r.value, live[j].r.value));
    const sources = all.length;
    let ok = true;
    let why: string | null = null;
    if (live.length >= 2 && spread !== null && spread > rule.toleranceBps) {
      ok = false;
      why = `The sources are ${spread} basis points apart, more than the ${rule.toleranceBps} allowed, and with two sources there is no telling which one is wrong.`;
    } else if (live.length === 0) {
      ok = false;
      why = "No source gave a reading that could be used.";
    } else if (live.length === 1 && sources >= 2) {
      // The others answered and were dropped: one voice left is not agreement.
      ok = false;
      why = `Only one of ${sources} sources gave a usable reading; the other was dropped as ${dropped.map((d) => d.reason).join(", ")}.`;
    }
    out.set(key, { key, sources, agreed: ok ? live.length : 0, agreedSources: ok ? live.map((x) => x.source) : [], spreadBps: spread, dropped, ok, why });
  }
  return out;
}
