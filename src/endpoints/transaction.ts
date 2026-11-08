import { getSessionFromCtx } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import { discourseAPIError } from "../errors.js";
import {
  createDiscourseConnectRequest,
  verifyDiscourseConnectResponse,
} from "../protocol.js";
import type { DiscourseConnectClaims } from "../protocol.js";
import {
  consumeTransactionState,
  createTransactionState,
  validateDestination,
} from "../state.js";
import type { StateOperation, TransactionState } from "../state.js";
import { createBetterAuthTransactionStateStorage } from "../storage/better-auth.js";

type EndpointContext = Parameters<typeof getSessionFromCtx>[0];
type IdentityWork = (
  transaction:
    | { operation: "sign-in"; claims: DiscourseConnectClaims }
    | {
        operation: "link";
        claims: DiscourseConnectClaims;
        initiatingUser: { userId: string; email: string };
      },
) => Promise<"SIGN_IN_FAILED" | "LINK_FAILED" | void>;

/** Begin a browser-bound attempt; the endpoint retains its own error mapping. */
export async function beginDiscourseTransaction(
  ctx: EndpointContext,
  options: { discourseURL: string; secret: string },
  operation: StateOperation,
) {
  let linkContext;
  if (operation === "link") {
    let session;
    try {
      session = await getSessionFromCtx(ctx, { disableCookieCache: true });
    } catch {
      session = null;
    }
    const token = getSessionCookie(ctx.headers ?? new Headers());
    if (!session?.user?.id || !session?.session?.id || !token)
      throw discourseAPIError("SESSION_REQUIRED");
    linkContext = {
      initiatingUserId: session.user.id,
      initiatingSessionId: session.session.id,
      initiatingSessionToken: token,
    };
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const successURL = destination(ctx, body.callbackURL, "/");
  const errorURL = destination(ctx, body.errorCallbackURL, successURL);
  const base = new URL(ctx.context.baseURL);
  const basePath = base.pathname.replace(/\/$/, "");
  const callbackURL = new URL(
    `${basePath}/discourse/callback`,
    base.origin,
  ).toString();
  const state = await createTransactionState(
    createBetterAuthTransactionStateStorage(ctx.context.adapter),
    {
      operation,
      successURL,
      errorURL,
      trustedOrigins: originPolicy(ctx),
      ...linkContext,
    },
    ctx.context.secret,
  );
  const request = await createDiscourseConnectRequest({
    discourseURL: options.discourseURL,
    returnSSOURL: callbackURL,
    nonce: state.nonce,
    secret: options.secret,
  });
  writeBinding(ctx, state.nonce, state.browserSecret, state.expiresAt);
  return { url: request.authorizationURL, redirect: true };
}

/** Recover trusted state before allowing any identity work or error redirect. */
export async function recoverDiscourseTransaction(
  ctx: EndpointContext,
  secret: string,
) {
  let claims: DiscourseConnectClaims;
  try {
    const url = new URL(ctx.request!.url);
    // Verify the exact raw query, including duplicate-parameter rejection.
    claims = await verifyDiscourseConnectResponse(url.search.slice(1), secret);
  } catch {
    throw discourseAPIError("INVALID_RESPONSE");
  }
  if (!/^[a-f0-9]{64}$/.test(claims.nonce))
    throw discourseAPIError("INVALID_STATE");
  let stored;
  try {
    const browserSecret = ctx.getCookie(stateCookieName(claims.nonce));
    if (typeof browserSecret !== "string" || !browserSecret)
      throw discourseAPIError("INVALID_STATE");
    stored = await consumeTransactionState(
      createBetterAuthTransactionStateStorage(ctx.context.adapter),
      { nonce: claims.nonce, browserSecret },
      ctx.context.secret,
    );
    // Keep this after a returned consume, including null, but not a thrown one.
    writeBinding(ctx, claims.nonce, "", null);
  } catch {
    throw discourseAPIError("INVALID_STATE");
  }
  if (!stored) throw discourseAPIError("INVALID_STATE");
  const state = stored;
  return {
    async complete(work: IdentityWork) {
      try {
        let failure;
        if (state.operation === "link") {
          const initiatingUser = await revalidateInitiatingUser(ctx, state);
          if (!initiatingUser)
            return ctx.redirect(appendError(state.errorURL, "SESSION_INVALID"));
          failure = await work({ operation: "link", claims, initiatingUser });
        } else {
          failure = await work({ operation: "sign-in", claims });
        }
        return ctx.redirect(
          failure ? appendError(state.errorURL, failure) : state.successURL,
        );
      } catch {
        return ctx.redirect(
          appendError(state.errorURL, "AUTHENTICATION_FAILED"),
        );
      }
    },
  };
}

async function revalidateInitiatingUser(
  ctx: EndpointContext,
  state: TransactionState,
) {
  const live = await getSessionFromCtx(ctx, { disableCookieCache: true });
  if (
    !live?.user ||
    live.user.id !== state.initiatingUserId ||
    live.session?.id !== state.initiatingSessionId ||
    !live.session ||
    new Date(live.session.expiresAt).getTime() <= Date.now()
  ) {
    return null;
  }
  // Hash the live cookie token, never persisting the bearer token in state.
  const token = getSessionCookie(ctx.headers!);
  const tokenBytes = new TextEncoder().encode(token ?? "");
  const hashBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", tokenBytes),
  );
  const digest = Array.from(hashBytes, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== state.initiatingSessionTokenHash) return null;
  return { userId: live.user.id, email: live.user.email };
}

function originPolicy(ctx: EndpointContext): string[] {
  const origins: string[] = [];
  try {
    origins.push(new URL(ctx.context.baseURL).origin);
  } catch {
    /* no configured base URL */
  }
  origins.push(
    ...(ctx.context.trustedOrigins ?? []).filter(
      (origin): origin is string => typeof origin === "string",
    ),
  );
  return [...new Set(origins)];
}

function destination(ctx: EndpointContext, value: unknown, fallback: string) {
  return validateDestination(typeof value === "string" ? value : fallback, {
    trustedOrigins: originPolicy(ctx),
  });
}

function stateCookieName(nonce: string) {
  return `discourse-connect-${nonce}`;
}

function writeBinding(
  ctx: EndpointContext,
  nonce: string,
  secret: string,
  expiresAt: number | null,
) {
  const secure =
    process.env.NODE_ENV === "production" ||
    new URL(ctx.context.baseURL).protocol === "https:";
  ctx.setCookie(stateCookieName(nonce), secret, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: new URL(ctx.context.baseURL).pathname.replace(/\/$/, "") || "/",
    maxAge:
      expiresAt === null
        ? 0
        : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}

function appendError(destination: string, code: string): string {
  const url = new URL(destination, "http://localhost");
  url.searchParams.set("error", code);
  return destination.startsWith("/")
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}
