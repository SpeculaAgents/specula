// A real engine on a free port for the package tests: recorded chain data and public documents, payments off.
import { startEngine, type Engine } from "../engine/src/main.ts";
import { ENGINE_KEY, readJson, replayFetch, replayTransport, type FetchTape, type Tape } from "../engine/test/helpers.ts";

export const ENGINE_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export async function localEngine(): Promise<Engine> {
  const chain = readJson<{ tape: Tape }>("chain.json");
  const docs = readJson<FetchTape>("docs.json");
  return startEngine({ port: 0, dbPath: ":memory:", engineKey: ENGINE_KEY, payments: false, secMinGapMs: 0 }, { jobs: false, env: {}, transport: replayTransport(chain.tape), fetch: replayFetch(docs) });
}
