import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/server/auth/next";
import { logout } from "@/server/auth/service";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { rejectCrossOrigin } from "@/server/http/origin";
import { requestMeta } from "@/server/http/request";

// POST only: a GET must never sign the operator out.
export async function POST(request: Request) {
  const rejected = rejectCrossOrigin(request, env().appOrigin);
  if (rejected) return rejected;

  const session = await getSession();
  if (session) {
    await logout(
      db(),
      { sessionId: session.sessionId, userId: session.user.id, displayName: session.user.displayName },
      await requestMeta(),
    );
  }
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", env().appOrigin), 303);
}
