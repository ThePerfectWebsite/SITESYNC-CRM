"use server";

import { notFound, redirect } from "next/navigation";
import { getSession, setSessionCookie } from "@/server/auth/next";
import {
  hasAnyUser,
  login,
  loginSchema,
  SetupAlreadyCompletedError,
  setupFirstAdmin,
  setupSchema,
} from "@/server/auth/service";
import { db } from "@/server/db";
import { requestMeta } from "@/server/http/request";

// The only Server Actions exempt from requireSession (spec §4): setup while no
// user exists, and login.

export type FormState = {
  message?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values?: Record<string, string>;
};

function firstErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return errors;
}

export async function setupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const database = db();
  if (await hasAnyUser(database)) notFound();

  const raw = {
    email: String(formData.get("email") ?? ""),
    displayName: String(formData.get("displayName") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  };
  const values = { email: raw.email, displayName: raw.displayName };
  const parsed = setupSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: firstErrors(parsed.error.issues), values };
  }

  try {
    await setupFirstAdmin(database, parsed.data, await requestMeta());
  } catch (error) {
    if (error instanceof SetupAlreadyCompletedError) notFound();
    throw error;
  }
  redirect("/login?setup=done");
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const database = db();
  if (!(await hasAnyUser(database))) redirect("/setup");

  const raw = {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  };
  const values = { email: raw.email };
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: firstErrors(parsed.error.issues), values };
  }

  const previous = await getSession();
  const result = await login(database, parsed.data, await requestMeta(), previous?.sessionId);
  if (!result.ok) {
    return {
      message:
        result.reason === "throttled"
          ? `Too many attempts. Wait ${result.retryAfterSeconds} second${result.retryAfterSeconds === 1 ? "" : "s"} and try again.`
          : "Email or password is incorrect.",
      values,
    };
  }
  await setSessionCookie(result.token, result.expiresAt);
  redirect("/");
}
