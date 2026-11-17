import type { Feed } from "./collect.ts";

/** The live list of feeds. The catalog fills it; everything else looks feeds up here, which keeps imports one-way. */
export const FEEDS: Feed[] = [];
export const feedById = (id: string) => FEEDS.find((f) => f.id === id);
