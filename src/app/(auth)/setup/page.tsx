import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hasAnyUser } from "@/server/auth/service";
import { db } from "@/server/db";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "First-run setup" };

// Only reachable while no user exists; afterwards it is a 404 (spec §4).
export default async function SetupPage() {
  if (await hasAnyUser(db())) notFound();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl font-semibold">Create the admin account</h1>
        </CardTitle>
        <CardDescription>
          This is a one-time step. SiteSync has no default password; this account is the only way in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetupForm />
      </CardContent>
    </Card>
  );
}
