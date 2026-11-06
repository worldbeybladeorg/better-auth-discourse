import { getMigrations } from "better-auth/db/migration";
import { auth, database } from "../server/auth.ts";

// An explicit setup command, never run in a request handler or on server startup.
try {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
    auth.options,
  );
  console.log(
    "Tables to create:",
    toBeCreated.map(({ table }) => table),
  );
  console.log(
    "Tables to alter:",
    toBeAdded.map(({ table }) => table),
  );
  await runMigrations();
  console.log("Better Auth and DiscourseConnect schemas are ready.");
} finally {
  database.close();
}
