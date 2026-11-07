import { authClient } from "./auth-client.ts";
import { formatDiscourseProfile } from "./discourse-profile.ts";
import type { DiscourseProfileSnapshot } from "./discourse-profile.ts";
import "./style.css";

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing element ${selector}`);
  return result;
}

const status = element("#status");
const link = element<HTMLButtonElement>("#discourse-link");
const signOut = element<HTMLButtonElement>("#sign-out");
let linkingEnabled = false;
let signedIn = false;
let busy = false;

function updateButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
  link.disabled = busy || !signedIn || !linkingEnabled;
  signOut.disabled = busy || !signedIn;
}

function checkError(result: {
  error: { message?: string | undefined; code?: string | undefined } | null;
}): void {
  if (result.error)
    throw new Error(
      result.error.message ?? result.error.code ?? "Authentication failed.",
    );
}

async function refresh(): Promise<void> {
  const result = await authClient.getSession();
  checkError(result);
  signedIn = Boolean(result.data);
  const { discourseProfile, ...user } = result.data?.user ?? {};
  element("#discourse-profile").textContent = formatDiscourseProfile(
    discourseProfile as DiscourseProfileSnapshot | null | undefined,
  );
  // Select display fields explicitly: don't dump the session token or accounts' credentials.
  const session = result.data
    ? {
        user,
        session: {
          id: result.data.session.id,
          userId: result.data.session.userId,
          expiresAt: result.data.session.expiresAt,
        },
      }
    : null;
  element("#session").textContent = JSON.stringify(session, null, 2);
  element("#accounts").textContent = "[]";
  if (signedIn) {
    const accounts = await authClient.listAccounts();
    checkError(accounts);
    element("#accounts").textContent = JSON.stringify(
      accounts.data?.map((account) => ({
        id: account.id,
        providerId: account.providerId,
        accountId: account.accountId,
      })),
      null,
      2,
    );
  }
  updateButtons();
}

async function run(
  action: () => Promise<void>,
  message: string,
): Promise<void> {
  if (busy) return;
  busy = true;
  updateButtons();
  status.textContent = "Working…";
  status.dataset.error = "false";
  try {
    await action();
    status.textContent = message;
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Request failed.";
    status.dataset.error = "true";
  } finally {
    busy = false;
    updateButtons();
  }
}

element("#discourse-sign-in").addEventListener(
  "click",
  () =>
    void run(async () => {
      checkError(
        await authClient.signIn.discourse({
          callbackURL: "/?flow=sign-in",
          errorCallbackURL: "/",
        }),
      );
    }, "Redirecting to Discourse…"),
);

link.addEventListener(
  "click",
  () =>
    void run(async () => {
      checkError(
        await authClient.discourse.link({
          callbackURL: "/?flow=link",
          errorCallbackURL: "/",
        }),
      );
    }, "Redirecting to Discourse to link your identity…"),
);

signOut.addEventListener(
  "click",
  () =>
    void run(async () => {
      checkError(await authClient.signOut());
      await refresh();
    }, "Signed out locally. Your Discourse session is unchanged."),
);

element("#refresh").addEventListener(
  "click",
  () => void run(refresh, "Session refreshed."),
);

element<HTMLFormElement>("#credentials").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const fields = new FormData(form);
  const action = (event.submitter as HTMLButtonElement | null)?.value;
  void run(async () => {
    const credentials = {
      email: String(fields.get("email") ?? ""),
      password: String(fields.get("password") ?? ""),
    };
    if (action === "sign-up") {
      const name = String(fields.get("name") ?? "").trim();
      if (!name) throw new Error("Enter a name to create a local account.");
      checkError(await authClient.signUp.email({ ...credentials, name }));
    } else {
      checkError(await authClient.signIn.email(credentials));
    }
    form.reset();
    await refresh();
  }, "Local session ready.");
});

void run(async () => {
  const response = await fetch("/api/playground");
  if (!response.ok)
    throw new Error(
      "Could not load server configuration. Check the Nitro console and .env.",
    );
  const config = (await response.json()) as { linkingEnabled: boolean };
  linkingEnabled = config.linkingEnabled;
  element("#linking-policy").textContent = linkingEnabled
    ? "Discourse is trusted for linking. Sign in locally first; matching emails are required."
    : "Linking is disabled. Set DISCOURSE_TRUST_FOR_LINKING=true in .env and restart to opt in.";
  await refresh();
  const params = new URLSearchParams(window.location.search);
  if (params.has("error"))
    throw new Error(`Discourse callback failed: ${params.get("error")}`);
}, "Ready. Choose an authentication flow; after a Discourse callback, inspect the session and linked accounts below.");
