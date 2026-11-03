// Points every integration test at the disposable test database, never the app database.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

for (const name of ["DATABASE_URL_TEST", "DATABASE_OWNER_URL_TEST"]) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for integration tests (see .env.example).`);
  if (!/\/[^/]*_test(\?|$)/.test(value)) {
    throw new Error(`${name} must point at a database whose name ends in _test.`);
  }
}

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
