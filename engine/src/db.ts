import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- collection
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, feed TEXT NOT NULL, params TEXT NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL,
  collected_at INTEGER NOT NULL, digest TEXT NOT NULL, signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_feed ON cache(feed, collected_at);
CREATE TABLE IF NOT EXISTS source_health (
  feed TEXT NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER, last_fail_at INTEGER, last_error TEXT, ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (feed, source)
);
CREATE TABLE IF NOT EXISTS health_hour (
  feed TEXT NOT NULL, source TEXT NOT NULL, hour INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (feed, source, hour)
);

-- requests, payments
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, feed TEXT NOT NULL, params TEXT NOT NULL, wallet TEXT, who TEXT NOT NULL,
  tier TEXT NOT NULL, price TEXT NOT NULL, paid_by TEXT NOT NULL, status TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, via TEXT
);
CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
CREATE INDEX IF NOT EXISTS requests_wallet ON requests(wallet, at);
CREATE INDEX IF NOT EXISTS requests_who ON requests(who, at);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, request_id TEXT, wallet TEXT NOT NULL, kind TEXT NOT NULL, amount TEXT NOT NULL, asset TEXT NOT NULL,
  tx TEXT, at INTEGER NOT NULL, feed TEXT, digest TEXT NOT NULL, signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_wallet ON receipts(wallet, at);
CREATE TABLE IF NOT EXISTS credits (wallet TEXT PRIMARY KEY, balance TEXT NOT NULL DEFAULT '0', spent_30d TEXT NOT NULL DEFAULT '0');
CREATE TABLE IF NOT EXISTS budgets (wallet TEXT PRIMARY KEY, daily TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gas_spend (day INTEGER NOT NULL, kind TEXT NOT NULL, account TEXT NOT NULL, gas TEXT NOT NULL DEFAULT '0', txs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, account));
CREATE TABLE IF NOT EXISTS used_nonces (asset TEXT NOT NULL, payer TEXT NOT NULL, nonce TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (asset, payer, nonce));

-- chain index
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, curve TEXT, name TEXT, symbol TEXT, deployer TEXT, launch_block INTEGER, launch_time INTEGER,
  launch_seen INTEGER NOT NULL DEFAULT 0, tax_bps INTEGER, phase INTEGER NOT NULL DEFAULT 0, pool_id TEXT, graduated_at INTEGER,
  supply TEXT
);
CREATE INDEX IF NOT EXISTS tokens_curve ON tokens(curve);
CREATE INDEX IF NOT EXISTS tokens_launch ON tokens(launch_time);
CREATE TABLE IF NOT EXISTS trades (
  token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL,
  side TEXT NOT NULL, trader TEXT NOT NULL, quote TEXT NOT NULL, amount TEXT NOT NULL, fee TEXT NOT NULL DEFAULT '0',
  tax TEXT NOT NULL DEFAULT '0', venue TEXT NOT NULL, quote_asset TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000', PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS trades_token ON trades(token, block);
CREATE INDEX IF NOT EXISTS trades_trader ON trades(trader, block);
CREATE INDEX IF NOT EXISTS trades_time ON trades(time);
CREATE TABLE IF NOT EXISTS liquidity (
  pool_id TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL,
  sender TEXT NOT NULL, tick_lower INTEGER NOT NULL, tick_upper INTEGER NOT NULL, delta TEXT NOT NULL, PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS liquidity_pool ON liquidity(pool_id, block);
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL, fee INTEGER NOT NULL, tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL, block INTEGER, kind TEXT NOT NULL DEFAULT 'v4'
);
CREATE TABLE IF NOT EXISTS assets (address TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER NOT NULL DEFAULT 18);
CREATE TABLE IF NOT EXISTS holders (token TEXT NOT NULL, holder TEXT NOT NULL, balance TEXT NOT NULL, PRIMARY KEY (token, holder));
CREATE TABLE IF NOT EXISTS holder_progress (token TEXT PRIMARY KEY, from_block INTEGER NOT NULL, last_block INTEGER NOT NULL, transfers INTEGER NOT NULL DEFAULT 0, burned TEXT NOT NULL DEFAULT '0');
CREATE TABLE IF NOT EXISTS burns (
  token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL,
  sender TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS burns_token ON burns(token, block);
-- a token moving from one address to another (mints and burns are not kept here)
CREATE TABLE IF NOT EXISTS transfers (
  token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL,
  sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_token ON transfers(token, block);
CREATE TABLE IF NOT EXISTS price_ticks (symbol TEXT NOT NULL, time INTEGER NOT NULL, answer TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (symbol, updated_at));

-- signals
CREATE TABLE IF NOT EXISTS signal_rules (
  id TEXT PRIMARY KEY, owner TEXT, name TEXT NOT NULL, text TEXT, rule TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS signal_fires (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, at INTEGER NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL,
  ref_value TEXT, check_at INTEGER, outcome TEXT, outcome_value TEXT, dedupe TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS fires_rule ON signal_fires(rule_id, at);
CREATE INDEX IF NOT EXISTS fires_at ON signal_fires(at);

-- ask the data
CREATE TABLE IF NOT EXISTS briefings (day TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);

-- verified data
CREATE TABLE IF NOT EXISTS leaves (digest TEXT PRIMARY KEY, hour INTEGER NOT NULL, feed TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS leaves_hour ON leaves(hour);
CREATE TABLE IF NOT EXISTS roots (hour INTEGER PRIMARY KEY, root TEXT NOT NULL, count INTEGER NOT NULL, at INTEGER NOT NULL, signature TEXT NOT NULL, tx TEXT);

-- point-in-time archive
CREATE TABLE IF NOT EXISTS archive (
  feed TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, params TEXT NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL,
  digest TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY (key, at)
);
CREATE INDEX IF NOT EXISTS archive_feed ON archive(feed, at);

-- marketplace, bounties, private feeds
CREATE TABLE IF NOT EXISTS market_feeds (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, price TEXT NOT NULL, url TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '[]', allow TEXT, ttl INTEGER NOT NULL DEFAULT 30, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, funder TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, amount TEXT NOT NULL,
  deadline INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pledged', winner TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bounty_offers (bounty TEXT NOT NULL, feed TEXT NOT NULL, seller TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (bounty, feed));

-- strategy testing
CREATE TABLE IF NOT EXISTS paper_runs (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, strategy TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);

-- teams
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, daily TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS team_members (team TEXT NOT NULL, wallet TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'member', added_at INTEGER NOT NULL, PRIMARY KEY (team, wallet));
-- a wallet joins a team only by accepting an invite with its own signature
CREATE TABLE IF NOT EXISTS team_invites (team TEXT NOT NULL, wallet TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (team, wallet));

-- own indexes
CREATE TABLE IF NOT EXISTS index_points (index_id TEXT NOT NULL, time INTEGER NOT NULL, value TEXT NOT NULL, parts TEXT NOT NULL, PRIMARY KEY (index_id, time));
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  // Columns added after the first release.
  const cols = (db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("ip")) db.exec("ALTER TABLE requests ADD COLUMN ip TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS requests_ip ON requests(ip, at)");
  return db;
}

export const kvGet = (db: DB, key: string): string | null => (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
export const kvSet = (db: DB, key: string, value: string) => db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
