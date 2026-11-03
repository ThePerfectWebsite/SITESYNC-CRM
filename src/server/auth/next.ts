import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "../db";
import { getSessionPolicy } from "./policy";
import { hasAnyUser } from "./service";
import { SESSION_COOKIE, validateSessionToken, type ValidSession } from "./session";

/** The current session (validated against the DB once per request), or null. */
export const getSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const database = db();
  return validateSessionToken(database, token, await getSessionPolicy(database));
});

/**
 * First call in every protected page, Server Action and Route Handler.
 * Redirects to /setup on first run, or /login without a valid session.
 */
export async function requireSession(): Promise<ValidSession> {
  if (!(await hasAnyUser(db()))) redirect("/setup");
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // localhost counts as a secure context in current browsers
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
}
