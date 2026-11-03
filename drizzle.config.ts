import { defineConfig } from "drizzle-kit";

// Migrations are generated from src/server/db/schema.ts plus hand-written
// custom migrations (extensions, functions, triggers, roles/grants).
// They are applied by `npm run db:migrate` as role sitesync_owner.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
