import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { formatDiscourseProfile } from "../src/discourse-profile.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const discourseSecret = "smoke-test-discourse-secret";

test("profile display distinguishes absent claims, false, and empty groups", () => {
  assert.match(formatDiscourseProfile(null), /No Discourse profile captured/);
  const display = JSON.parse(
    formatDiscourseProfile({
      id: "member",
      email: "member@example.test",
      name: "Member",
      capturedAt: "2026-01-01T00:00:00.000Z",
      groups: [],
      admin: false,
      moderator: true,
      confirmed2FA: false,
      no2FAMethods: true,
      profileBackgroundURL: "<script>not HTML</script>",
    }),
  );
  assert.deepEqual(display.groups, []);
  assert.equal(display.admin, false);
  assert.equal(display.moderator, true);
  assert.equal(display.confirmed2FA, false);
  assert.equal(display.no2FAMethods, true);
  assert.equal(display.cardBackgroundURL, "Not provided");
  assert.equal(display.profileBackgroundURL, "<script>not HTML</script>");
  assert.equal(JSON.parse(formatDiscourseProfile({})).groups, "Not provided");
});

// Exercise the actual Nitro HTTP adapter in both Vite dev and the Node build.
// The test signs provider responses locally; no real Discourse site is contacted.
for (const mode of ["development", "production"]) {
  test(
    `${mode}: session, sign-in, explicit linking, and cookies`,
    { timeout: 60_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "discourse-playground-"));
      let server;
      t.after(async () => {
        if (server && server.exitCode === null && server.signalCode === null) {
          const exited = once(server, "exit");
          server.kill("SIGTERM");
          await exited;
        }
        await rm(directory, { recursive: true, force: true });
      });
      const socket = createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const port = socket.address().port;
      await new Promise((resolve, reject) =>
        socket.close((error) => (error ? reject(error) : resolve())),
      );
      const origin = `http://127.0.0.1:${port}`;
      const env = {
        ...process.env,
        NODE_ENV: mode,
        HOST: "127.0.0.1",
        PORT: String(port),
        BETTER_AUTH_URL: `${origin}/api/auth`,
        BETTER_AUTH_SECRET: "smoke-test-auth-secret-at-least-32-characters",
        DISCOURSE_URL: "https://forum.example.test",
        DISCOURSE_CONNECT_SECRET: discourseSecret,
        DISCOURSE_TRUST_FOR_LINKING: "true",
        SQLITE_PATH: join(directory, "auth.sqlite"),
      };
      const migration = spawnSync(process.execPath, ["scripts/migrate.ts"], {
        cwd,
        env,
        encoding: "utf8",
      });
      assert.equal(migration.status, 0, migration.stdout + migration.stderr);
      assert.match(migration.stdout, /discourseConnectState/);
      assert.match(migration.stdout, /discourseIdentityGuard/);

      const args =
        mode === "development"
          ? [
              "node_modules/vite/bin/vite.js",
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
            ]
          : [".output/server/index.mjs"];
      server = spawn(process.execPath, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      server.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      server.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null) assert.fail(logs);
        try {
          const response = await fetch(`${origin}/api/auth/ok`);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Wait for the HTTP listener. */
        }
        await setTimeout(100);
      }
      assert.ok(ready, logs);

      const cookies = new Map();
      async function request(path, body) {
        const response = await fetch(`${origin}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            origin,
            cookie: [...cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "manual",
        });
        for (const header of response.headers.getSetCookie()) {
          const pair = header.split(";")[0];
          const separator = pair.indexOf("=");
          cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        return response;
      }

      async function roundTrip(endpoint, externalId, email, claims = {}) {
        const start = await request(endpoint, {
          callbackURL: "/?flow=done",
          errorCallbackURL: "/",
        });
        assert.equal(start.status, 200, await start.clone().text());
        assert.match(
          start.headers.get("set-cookie"),
          /discourse-connect-.*HttpOnly/,
        );
        const { url } = await start.json();
        const provider = new URL(url);
        assert.equal(provider.origin, "https://forum.example.test");
        const payload = provider.searchParams.get("sso");
        assert.equal(
          provider.searchParams.get("sig"),
          createHmac("sha256", discourseSecret).update(payload).digest("hex"),
        );
        const params = new URLSearchParams(
          Buffer.from(payload, "base64").toString(),
        );
        assert.equal(
          params.get("return_sso_url"),
          `${origin}/api/auth/discourse/callback`,
        );
        const sso = Buffer.from(
          new URLSearchParams({
            nonce: params.get("nonce"),
            external_id: externalId,
            email,
            name: "Test member",
            ...claims,
          }).toString(),
        ).toString("base64");
        const sig = createHmac("sha256", discourseSecret)
          .update(sso)
          .digest("hex");
        const callback = await request(
          `/api/auth/discourse/callback?${new URLSearchParams({ sso, sig })}`,
        );
        assert.equal(callback.status, 302, await callback.clone().text());
        assert.equal(callback.headers.get("location"), "/?flow=done");
        return callback;
      }

      assert.match(
        await (await request("/")).text(),
        /DiscourseConnect playground/,
      );
      assert.match(await (await request("/")).text(), /id="discourse-profile"/);
      assert.deepEqual(await (await request("/api/playground")).json(), {
        linkingEnabled: true,
      });
      assert.equal(await (await request("/api/auth/get-session")).json(), null);
      assert.equal((await request("/api/auth/discourse/link", {})).status, 401);

      const callback = await roundTrip(
        "/api/auth/sign-in/discourse",
        "discourse-first",
        "first@example.test",
        {
          groups: "Staff,Trust Level 2",
          admin: "false",
          moderator: "true",
          profile_background_url: "https://forum.example.test/profile.png",
          card_background_url: "https://forum.example.test/card.png",
          confirmed_2fa: "true",
          no_2fa_methods: "false",
        },
      );
      assert.match(
        callback.headers.get("set-cookie"),
        /better-auth.session_token/,
      );
      const first = await (await request("/api/auth/get-session")).json();
      assert.equal(first.user.email, "first@example.test");
      assert.equal(first.user.emailVerified, false);
      assert.deepEqual(first.user.discourseProfile, {
        id: "discourse-first",
        email: "first@example.test",
        name: "Test member",
        groups: ["Staff", "Trust Level 2"],
        admin: false,
        moderator: true,
        profileBackgroundURL: "https://forum.example.test/profile.png",
        cardBackgroundURL: "https://forum.example.test/card.png",
        confirmed2FA: true,
        no2FAMethods: false,
        capturedAt: first.user.discourseProfile.capturedAt,
      });
      assert.ok(
        Number.isFinite(Date.parse(first.user.discourseProfile.capturedAt)),
      );
      // Profile metadata is server-owned even though provider mapping requires input:true.
      const forgedUpdate = await request("/api/auth/update-user", {
        discourseProfile: { admin: true },
      });
      assert.equal(forgedUpdate.status, 400);
      assert.deepEqual(
        (await (await request("/api/auth/get-session")).json()).user
          .discourseProfile,
        first.user.discourseProfile,
      );
      assert.equal((await request("/api/auth/sign-out", {})).status, 200);
      assert.equal(await (await request("/api/auth/get-session")).json(), null);

      const forgedSignup = await request("/api/auth/sign-up/email", {
        name: "Local member",
        email: "local@example.test",
        password: "throwaway-password-123",
        discourseProfile: { admin: true },
      });
      assert.equal(forgedSignup.status, 400);
      const signup = await request("/api/auth/sign-up/email", {
        name: "Local member",
        email: "local@example.test",
        password: "throwaway-password-123",
      });
      assert.equal(signup.status, 200, await signup.clone().text());
      const local = await (await request("/api/auth/get-session")).json();
      assert.equal(local.user.discourseProfile, null);
      await roundTrip(
        "/api/auth/discourse/link",
        "discourse-linked",
        "local@example.test",
        {
          groups: "",
          admin: "true",
          moderator: "false",
          confirmed_2fa: "false",
          no_2fa_methods: "true",
        },
      );
      const accounts = await (await request("/api/auth/list-accounts")).json();
      assert.ok(
        accounts.some(
          (account) =>
            account.providerId === "discourse" &&
            account.accountId === "discourse-linked",
        ),
      );
      const linked = await (await request("/api/auth/get-session")).json();
      assert.equal(linked.user.id, local.user.id);
      assert.equal(linked.user.email, local.user.email);
      assert.equal(linked.user.emailVerified, local.user.emailVerified);
      assert.deepEqual(linked.user.discourseProfile.groups, []);
      assert.equal(linked.user.discourseProfile.admin, true);
      assert.equal(linked.user.discourseProfile.moderator, false);
      assert.equal(linked.user.discourseProfile.confirmed2FA, false);
      assert.equal(linked.user.discourseProfile.no2FAMethods, true);
      assert.equal(
        linked.user.discourseProfile.profileBackgroundURL,
        undefined,
      );
      assert.equal(linked.user.admin, undefined);
      await request("/api/auth/sign-out", {});
      await roundTrip(
        "/api/auth/sign-in/discourse",
        "discourse-linked",
        "local@example.test",
      );
      const returning = await (await request("/api/auth/get-session")).json();
      assert.equal(returning.user.id, local.user.id);
      assert.equal(returning.user.discourseProfile.id, "discourse-linked");
      // Replace the snapshot, so omitted claims do not look like fresh assertions.
      assert.equal(returning.user.discourseProfile.groups, undefined);
      assert.equal(returning.user.discourseProfile.admin, undefined);
      assert.equal(returning.user.discourseProfile.confirmed2FA, undefined);
      await request("/api/auth/sign-out", {});
      assert.equal(await (await request("/api/auth/get-session")).json(), null);
    },
  );
}
