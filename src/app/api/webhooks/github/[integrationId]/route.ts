// POST /api/webhooks/github/<integration_id> (spec §7.3). Authenticated by the
// webhook's HMAC signature instead of a session, and exempt from the Origin
// check (GitHub's servers send it). Disabled unless the integration enables it.
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/ids";
import { db } from "@/server/db";
import { MAX_WEBHOOK_BYTES, receiveGitHubWebhook } from "@/server/integrations/webhooks";
import { enqueueWebhook } from "@/server/jobs/runtime";

export const dynamic = "force-dynamic";

/** Reads the raw body, giving up as soon as it passes the cap. */
async function readCappedBody(request: Request): Promise<Buffer | "too_large"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return "too_large";
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(request: Request, { params }: RouteContext<"/api/webhooks/github/[integrationId]">) {
  const { integrationId } = await params;
  if (!isUuid(integrationId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await readCappedBody(request);
  const result = await receiveGitHubWebhook(db(), { integrationId, headers: request.headers, body });
  if (result.status === 202) {
    if (result.process) {
      // Respond fast; processing happens in the job runner (or inline if it isn't running).
      void enqueueWebhook(result.inboxId).catch(() => undefined);
    }
    return NextResponse.json({ received: true }, { status: 202 });
  }
  if (result.status === 200) return NextResponse.json({ duplicate: true }, { status: 200 });
  return NextResponse.json({ error: result.error }, { status: result.status });
}
