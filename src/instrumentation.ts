// Runs once when the Next.js server starts. Starts the background job runner
// (GitHub polling, webhook processing, retention). Set SITESYNC_JOBS=off to
// run without it: manual refreshes then run inline.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.SITESYNC_JOBS === "off") return;
  const { startJobs } = await import("./server/jobs/runtime");
  await startJobs();
}
