import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempBase = "/tmp/opencode";
await mkdir(tempBase, { recursive: true });
const tempRoot = await mkdtemp(join(tempBase, "better-auth-package-"));
const consumer = join(tempRoot, "consumer");
const modules = join(consumer, "node_modules");

try {
  await mkdir(consumer);
  await mkdir(modules);
  execFileSync("pnpm", ["pack", "--pack-destination", tempRoot], {
    cwd: root,
    stdio: "inherit",
  });
  const archive = join(
    tempRoot,
    (await readdir(tempRoot)).find((file) => file.endsWith(".tgz")),
  );
  execFileSync("tar", ["-xzf", archive, "-C", modules], { cwd: tempRoot });
  const packageDir = join(modules, "package");

  for (const dependency of ["better-auth", "zod"]) {
    await symlink(
      resolve(root, "node_modules", dependency),
      join(modules, dependency),
      "dir",
    );
  }
  await mkdir(join(modules, "@types"));
  await symlink(
    resolve(root, "node_modules/@types/node"),
    join(modules, "@types/node"),
    "dir",
  );
  const packageJson = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  if (
    packageJson.exports?.["./storage/sqlite"]?.import !==
    "./dist/storage/sqlite.js"
  ) {
    throw new Error("Packed package is missing the Node SQLite subpath export");
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `
    import * as server from "better-auth-discourse";
    import * as client from "better-auth-discourse/client";
    import * as sqlite from "better-auth-discourse/storage/sqlite";
    if (!server.discourse || !client.discourseClient || !sqlite.createSqliteTransactionStateStorage) {
      throw new Error("Expected public exports were not found");
    }
  `,
  );
  // Expose the extracted tarball under its actual package name, not the source tree.
  await symlink(packageDir, join(modules, packageJson.name), "dir");
  execFileSync(process.execPath, [join(consumer, "smoke.mjs")], {
    cwd: consumer,
    stdio: "inherit",
  });

  await writeFile(
    join(consumer, "types.ts"),
    `
    import { createAuthClient } from "better-auth/client";
    import { discourse } from "better-auth-discourse";
    import { discourseClient } from "better-auth-discourse/client";
    import { createSqliteTransactionStateStorage } from "better-auth-discourse/storage/sqlite";
    void discourse; void createSqliteTransactionStateStorage;
    const authClient = createAuthClient({ plugins: [discourseClient()] });
    void authClient.signIn.discourse({ callbackURL: "/dashboard" });
    void authClient.discourse.link({ callbackURL: "/settings/accounts" });
    // @ts-expect-error callbackURL must be a string
    void authClient.signIn.discourse({ callbackURL: 42 });
    // @ts-expect-error client cannot control server-enforced registration policy
    void authClient.signIn.discourse({ disableSignUp: false });
    // @ts-expect-error linking accepts only documented endpoint fields
    void authClient.discourse.link({ arbitrary: "value" });
  `,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["types.ts"],
    }),
  );
  execFileSync(
    resolve(root, "node_modules/.bin/tsc"),
    ["-p", join(consumer, "tsconfig.json")],
    { cwd: consumer, stdio: "inherit" },
  );

  const result = await build({
    entryPoints: [join(packageDir, "dist/client.js")],
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    metafile: true,
    packages: "external",
  });
  const clientGraph = result.outputFiles.map((file) => file.text).join("\n");
  for (const forbidden of [
    "node:sqlite",
    "createDiscourseCallback",
    "createSignInDiscourse",
    "DISCOURSE_CONNECT_SECRET",
  ]) {
    if (clientGraph.includes(forbidden))
      throw new Error(
        `Client runtime bundle contains server-only marker: ${forbidden}`,
      );
  }
  const clientInputs = Object.keys(result.metafile.inputs).map((input) =>
    resolve(input),
  );
  if (
    clientInputs.length !== 1 ||
    clientInputs[0] !== resolve(packageDir, "dist/client.js")
  ) {
    throw new Error(
      `Unexpected client runtime dependency graph: ${clientInputs.join(", ")}`,
    );
  }
  console.log(
    "Packed server/client/SQLite imports, declaration resolution, and client isolation passed.",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
