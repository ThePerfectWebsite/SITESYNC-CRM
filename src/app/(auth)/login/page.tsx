import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSession } from "@/server/auth/next";
import { hasAnyUser } from "@/server/auth/service";
import { db } from "@/server/db";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (!(await hasAnyUser(db()))) redirect("/setup");
  if (await getSession()) redirect("/");
  const { setup } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl font-semibold">Sign in</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {setup === "done" ? (
          <Alert>
            <AlertDescription>Admin account created. Sign in to continue.</AlertDescription>
          </Alert>
        ) : null}
        <LoginForm />
      </CardContent>
    </Card>
  );
}
