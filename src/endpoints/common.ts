import { getSessionFromCtx } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import { validateDestination } from "../state.js";
type EndpointContext = Parameters<typeof getSessionFromCtx>[0];

export const BINDING_PREFIX = "discourse-connect-";
export const stateCookieName = (nonce: string) => `${BINDING_PREFIX}${nonce}`;

export function originPolicy(ctx: EndpointContext): string[] {
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

export function destination(
  ctx: EndpointContext,
  value: unknown,
  fallback: string,
): string {
  return validateDestination(typeof value === "string" ? value : fallback, {
    trustedOrigins: originPolicy(ctx),
  });
}

export function callbackEndpointURL(ctx: EndpointContext): string {
  const base = new URL(ctx.context.baseURL);
  const basePath = base.pathname.replace(/\/$/, "");
  return new URL(`${basePath}/discourse/callback`, base.origin).toString();
}

export function setBinding(
  ctx: EndpointContext,
  nonce: string,
  secret: string,
  expiresAt: number,
): void {
  const secure =
    process.env.NODE_ENV === "production" ||
    new URL(ctx.context.baseURL).protocol === "https:";
  ctx.setCookie(stateCookieName(nonce), secret, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: new URL(ctx.context.baseURL).pathname.replace(/\/$/, "") || "/",
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}

export function clearBinding(ctx: EndpointContext, nonce: string): void {
  const secure =
    process.env.NODE_ENV === "production" ||
    new URL(ctx.context.baseURL).protocol === "https:";
  ctx.setCookie(stateCookieName(nonce), "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: new URL(ctx.context.baseURL).pathname.replace(/\/$/, "") || "/",
    maxAge: 0,
  });
}

export function browserSecret(
  ctx: EndpointContext,
  nonce: string,
): string | null {
  const cookie = ctx.getCookie(stateCookieName(nonce));
  return typeof cookie === "string" ? cookie : null;
}

export async function activeSession(ctx: EndpointContext) {
  return getSessionFromCtx(ctx, { disableCookieCache: true });
}

export function sessionToken(ctx: EndpointContext): string | null {
  return getSessionCookie(ctx.headers ?? new Headers());
}
