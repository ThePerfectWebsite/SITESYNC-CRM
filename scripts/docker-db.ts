// Helpers for running Postgres client tools inside the compose `db` container,
// so the operator doesn't need them installed on the host.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";

type RunOptions = { stdinFile?: string; stdoutFile?: string };

/** Runs `docker compose exec -T db <args>`; resolves with captured stdout (unless redirected to a file). */
export function composeExec(args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "exec", "-T", "db", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let flushed: Promise<void> = Promise.resolve();
    if (options.stdoutFile) {
      const out = createWriteStream(options.stdoutFile);
      flushed = new Promise((done, fail) => out.on("finish", done).on("error", fail));
      child.stdout.pipe(out);
    } else {
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    }
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    if (options.stdinFile) {
      createReadStream(options.stdinFile).pipe(child.stdin);
    } else {
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) flushed.then(() => resolve(stdout), reject);
      else reject(new Error(`${args[0]} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export function utcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Same connection URL, different database name. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
