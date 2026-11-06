/** Persistent, single-use transaction state. Storage implementations MUST make
 * consume's match-and-delete a single atomic database operation. */

export type StateOperation = "sign-in" | "link";

export interface TransactionState {
  nonce: string;
  expiresAt: number;
  operation: StateOperation;
  successURL: string;
  errorURL: string;
  initiatingUserId?: string;
  initiatingSessionId?: string;
  /** SHA-256 of the Better Auth session token, never the bearer token itself. */
  initiatingSessionTokenHash?: string;
}

export interface StoredTransactionState extends TransactionState {
  stateHash: string;
  browserBindingHash: string;
  integrity: string;
}

/** Better Auth plugin schema contribution. Include this in the server plugin's
 * `schema` so the host's normal Better Auth schema generator creates it. */
export const transactionStateSchema = {
  discourseConnectState: {
    fields: {
      stateHash: { type: "string", required: true, unique: true },
      browserBindingHash: { type: "string", required: true },
      nonce: { type: "string", required: true },
      expiresAt: { type: "number", required: true },
      operation: { type: "string", required: true },
      successURL: { type: "string", required: true },
      errorURL: { type: "string", required: true },
      initiatingUserId: { type: "string", required: false },
      initiatingSessionId: { type: "string", required: false },
      initiatingSessionTokenHash: { type: "string", required: false },
      integrity: { type: "string", required: true },
    },
  },
} as const;

export interface TransactionStateStorage {
  /** Insert, enforcing unique stateHash. */
  insert(state: StoredTransactionState): Promise<void>;
  /** Atomically delete and return a matching, unexpired record. Exactly one
   * concurrent invocation may return a record. A mismatch must not consume it. */
  consume(input: {
    stateHash: string;
    browserBindingHash: string;
    now: number;
  }): Promise<StoredTransactionState | null>;
}

export interface DestinationPolicy {
  /** Origins allowed to receive a redirect, e.g. Better Auth trustedOrigins. */
  trustedOrigins: readonly string[];
}

export function validateDestination(
  value: string,
  policy: DestinationPolicy,
): string {
  if (
    typeof value !== "string" ||
    // eslint-disable-next-line no-control-regex -- Reject control characters before URL parsing can normalize them.
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("\\") ||
    value.startsWith("//") ||
    value.trim() !== value
  ) {
    throw new Error("INVALID_DESTINATION");
  }
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\"))
      throw new Error("INVALID_DESTINATION");
    const origin = policy.trustedOrigins.find((candidate) => {
      try {
        const parsed = new URL(candidate);
        return (
          parsed.origin === candidate.replace(/\/$/, "") &&
          ["http:", "https:"].includes(parsed.protocol)
        );
      } catch {
        return false;
      }
    });
    if (!origin) throw new Error("INVALID_DESTINATION");
    const resolved = new URL(value, origin);
    if (resolved.origin !== new URL(origin).origin)
      throw new Error("INVALID_DESTINATION");
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_DESTINATION");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("INVALID_DESTINATION");
  }
  const allowed = policy.trustedOrigins.some((origin) => {
    try {
      const trusted = new URL(origin);
      return (
        trusted.origin === origin.replace(/\/$/, "") &&
        trusted.origin === url.origin &&
        (trusted.protocol === "https:" || trusted.protocol === "http:")
      );
    } catch {
      return false;
    }
  });
  if (!allowed) throw new Error("INVALID_DESTINATION");
  return url.toString();
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
function source(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}
function hex(value: Uint8Array): string {
  return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function digest(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", source(bytes(value)))),
  );
}
async function hmac(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    source(bytes(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, source(bytes(value))),
    ),
  );
}
function randomToken(): string {
  const data = crypto.getRandomValues(new Uint8Array(32));
  return hex(data);
}
function canonical(state: TransactionState): string {
  return JSON.stringify([
    state.nonce,
    state.expiresAt,
    state.operation,
    state.successURL,
    state.errorURL,
    state.initiatingUserId ?? null,
    state.initiatingSessionId ?? null,
    state.initiatingSessionTokenHash ?? null,
  ]);
}

export interface CreateStateInput {
  operation: StateOperation;
  successURL: string;
  errorURL: string;
  trustedOrigins: readonly string[];
  browserSecret?: string;
  now?: number;
  ttlMs?: number;
  initiatingUserId?: string;
  initiatingSessionId?: string;
  initiatingSessionToken?: string;
}

/** Pure transaction-state API; HTTP cookie issuance/reading belongs to endpoints. */
export async function createTransactionState(
  storage: TransactionStateStorage,
  input: CreateStateInput,
  integrityKey: string,
): Promise<{ nonce: string; browserSecret: string; expiresAt: number }> {
  if (!integrityKey) throw new Error("INVALID_STATE_KEY");
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? 5 * 60_000;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(ttl) ||
    ttl <= 0 ||
    ttl > 60 * 60_000
  )
    throw new Error("INVALID_STATE_LIFETIME");
  if (
    input.operation === "sign-in" &&
    (input.initiatingUserId ||
      input.initiatingSessionId ||
      input.initiatingSessionToken)
  )
    throw new Error("INVALID_LINK_SESSION");
  const browserSecret = input.browserSecret ?? randomToken();
  if (!browserSecret || !["sign-in", "link"].includes(input.operation))
    throw new Error("INVALID_STATE_INPUT");
  if (
    input.operation === "link" &&
    (!input.initiatingUserId ||
      !input.initiatingSessionId ||
      !input.initiatingSessionToken)
  ) {
    throw new Error("INVALID_LINK_SESSION");
  }
  const nonce = randomToken();
  const state: TransactionState = {
    nonce,
    expiresAt: now + ttl,
    operation: input.operation,
    successURL: validateDestination(input.successURL, {
      trustedOrigins: input.trustedOrigins,
    }),
    errorURL: validateDestination(input.errorURL, {
      trustedOrigins: input.trustedOrigins,
    }),
    ...(input.initiatingUserId
      ? { initiatingUserId: input.initiatingUserId }
      : {}),
    ...(input.initiatingSessionId
      ? { initiatingSessionId: input.initiatingSessionId }
      : {}),
    ...(input.initiatingSessionToken
      ? {
          initiatingSessionTokenHash: await digest(
            input.initiatingSessionToken,
          ),
        }
      : {}),
  };
  await storage.insert({
    ...state,
    stateHash: await digest(nonce),
    browserBindingHash: await digest(browserSecret),
    integrity: await hmac(integrityKey, canonical(state)),
  });
  return { nonce, browserSecret, expiresAt: state.expiresAt };
}

export async function consumeTransactionState(
  storage: TransactionStateStorage,
  input: { nonce: string; browserSecret: string; now?: number },
  integrityKey: string,
): Promise<TransactionState | null> {
  if (!input.nonce || !input.browserSecret || !integrityKey) return null;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) return null;
  const stateHash = await digest(input.nonce);
  const browserBindingHash = await digest(input.browserSecret);
  const row = await storage.consume({ stateHash, browserBindingHash, now });
  if (!row) return null;
  const {
    stateHash: _stateHash,
    browserBindingHash: _browserHash,
    integrity,
    ...state
  } = row;
  if (
    _stateHash !== stateHash ||
    _browserHash !== browserBindingHash ||
    state.nonce !== input.nonce ||
    !Number.isFinite(state.expiresAt) ||
    state.expiresAt <= now ||
    !["sign-in", "link"].includes(state.operation) ||
    (state.operation === "sign-in" &&
      (state.initiatingUserId ||
        state.initiatingSessionId ||
        state.initiatingSessionTokenHash)) ||
    (state.operation === "link" &&
      (!state.initiatingUserId ||
        !state.initiatingSessionId ||
        !/^[a-f0-9]{64}$/.test(state.initiatingSessionTokenHash ?? ""))) ||
    typeof state.successURL !== "string" ||
    typeof state.errorURL !== "string" ||
    !constantTimeEqual(integrity, await hmac(integrityKey, canonical(state)))
  )
    return null;
  return state;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
