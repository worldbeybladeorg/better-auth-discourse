/** Plugin-owned Better Auth account-claim mutex model. Include this schema in
 * the server plugin and apply the host's normal Better Auth migrations. */
export const identityGuardSchema = {
  discourseIdentityGuard: {
    fields: {
      lockKey: { type: "string", required: true, unique: true },
      ownerToken: { type: "string", required: true },
      acquiredAt: { type: "number", required: true },
    },
  },
} as const;

type Where = { field: string; value: string | number };
type AdapterError = { code?: unknown; message?: unknown; cause?: unknown };
export interface BetterAuthIdentityGuardAdapter {
  create<T>(input: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<T>;
  findOne<T>(input: { model: string; where: Where[] }): Promise<T | null>;
  consumeOne<T>(input: { model: string; where: Where[] }): Promise<T | null>;
}

/** Durable atomic lock API consumed by identity resolution/linking. */
export interface DiscourseIdentityLockStorage {
  withLocks<T>(keys: readonly string[], work: () => Promise<T>): Promise<T>;
}

function isUniqueConstraintError(error: unknown): boolean {
  for (
    let current = error;
    current && typeof current === "object";
    current = (current as AdapterError).cause
  ) {
    const { code, message } = current as AdapterError;
    if (
      typeof code === "string" &&
      (code.startsWith("SQLITE_CONSTRAINT") || code === "23505")
    )
      return true;
    if (
      typeof message === "string" &&
      /unique constraint|duplicate key|unique violation/i.test(message)
    )
      return true;
  }
  return false;
}

/**
 * Uses Better Auth's factory-wrapped public adapter. Unique lockKey insertion
 * arbitrates acquisition; consumeOne conditionally deletes exactly the lock
 * owned by this caller. No expiring lease is used: stale locks fail closed.
 */
export function createBetterAuthIdentityGuard(
  adapter: BetterAuthIdentityGuardAdapter,
): DiscourseIdentityLockStorage {
  if (
    !adapter ||
    typeof adapter.create !== "function" ||
    typeof adapter.findOne !== "function" ||
    typeof adapter.consumeOne !== "function"
  ) {
    throw new Error("UNSUPPORTED_BETTER_AUTH_IDENTITY_GUARD_ADAPTER");
  }
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  return {
    async withLocks<T>(
      keys: readonly string[],
      work: () => Promise<T>,
    ): Promise<T> {
      const orderedKeys = [...new Set(keys)].sort();
      if (!orderedKeys.length || orderedKeys.some((key) => !key))
        throw new Error("IDENTITY_LOCK_KEYS_REQUIRED");
      const ownerToken = crypto.randomUUID();
      const acquired: string[] = [];
      let result: T | undefined;
      let operationError: unknown;
      try {
        for (const lockKey of orderedKeys) {
          let contentionAttempts = 0;
          for (;;) {
            try {
              await adapter.create({
                model: "discourseIdentityGuard",
                data: { lockKey, ownerToken, acquiredAt: Date.now() },
              });
              acquired.push(lockKey);
              break;
            } catch (createError) {
              // Only a recognizable uniqueness conflict means another writer
              // owns this key. Other failures must fail closed immediately.
              if (!isUniqueConstraintError(createError)) throw createError;
              const present = await adapter.findOne<{ lockKey: string }>({
                model: "discourseIdentityGuard",
                where: [{ field: "lockKey", value: lockKey }],
              });
              if (!present) throw createError;
              if (++contentionAttempts > 500)
                throw new Error("IDENTITY_LOCK_BUSY", { cause: createError });
              await pause();
            }
          }
        }
        result = await work();
      } catch (error) {
        operationError = error;
      }
      let releaseError: unknown;
      for (const lockKey of acquired.reverse()) {
        try {
          const released = await adapter.consumeOne({
            model: "discourseIdentityGuard",
            where: [
              { field: "lockKey", value: lockKey },
              { field: "ownerToken", value: ownerToken },
            ],
          });
          if (!released) throw new Error("IDENTITY_LOCK_RELEASE_FAILED");
        } catch (error) {
          releaseError ??= error;
        }
      }
      if (operationError !== undefined) throw operationError;
      if (releaseError !== undefined) throw releaseError;
      return result as T;
    },
  };
}
