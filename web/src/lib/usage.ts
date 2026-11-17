import type { Stats } from "./types";

/**
 * Specula's own usage counters (answers signed, requests served, per-feed request counts) stay off the site until
 * the engine reports this many paid answers. Counts of chain data are not usage and are always shown.
 */
export const USAGE_MIN_PAID_ANSWERS = 1000;

export const usageShown = (stats: Pick<Stats, "paidAnswers"> | null | undefined): boolean => (stats?.paidAnswers ?? 0) >= USAGE_MIN_PAID_ANSWERS;
