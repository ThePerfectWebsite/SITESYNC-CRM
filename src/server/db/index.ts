import "server-only";
import type pg from "pg";
import { env } from "../env";
import { createDb, createPool, type Db } from "./client";

// One pool per process; kept on globalThis so dev hot reloads don't leak pools.
const globalForDb = globalThis as unknown as { sitesyncPool?: pg.Pool; sitesyncDb?: Db };

export function pool(): pg.Pool {
  globalForDb.sitesyncPool ??= createPool(env().databaseUrl);
  return globalForDb.sitesyncPool;
}

export function db(): Db {
  globalForDb.sitesyncDb ??= createDb(pool());
  return globalForDb.sitesyncDb;
}

export * as schema from "./schema";
export type { Db, DbOrTx, Tx } from "./client";
