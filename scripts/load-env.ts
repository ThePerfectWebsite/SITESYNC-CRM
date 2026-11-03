// Loads .env for CLI scripts (Next.js loads it itself for the app).
import { existsSync } from "node:fs";

export function loadEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

export function requireVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} (see .env.example).`);
    process.exit(1);
  }
  return value;
}
