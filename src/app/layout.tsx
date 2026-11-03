import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "SiteSync Control Centre", template: "%s · SiteSync" },
  description: "Local control centre for clients, websites, projects and deployments.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Reading request headers keeps every page dynamically rendered, which the
  // per-request CSP nonce requires.
  await headers();
  return (
    <html lang="en-GB">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
