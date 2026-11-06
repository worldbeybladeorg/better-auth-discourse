import type { DatabaseSync } from "node:sqlite";
import type {
  StoredTransactionState,
  TransactionStateStorage,
} from "../state.js";

/** Create/migrate the plugin-owned transaction table on the supplied SQLite DB.
 * The caller owns the connection lifecycle and must share the same durable DB
 * across application instances. */
export function createSqliteTransactionStateStorage(
  database: DatabaseSync,
): TransactionStateStorage {
  database.exec(`
    CREATE TABLE IF NOT EXISTS better_auth_discourse_state (
      state_hash TEXT PRIMARY KEY NOT NULL,
      browser_binding_hash TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('sign-in', 'link')),
      success_url TEXT NOT NULL,
      error_url TEXT NOT NULL,
      initiating_user_id TEXT,
      initiating_session_id TEXT,
      initiating_session_token_hash TEXT,
      integrity TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS better_auth_discourse_state_expiry
      ON better_auth_discourse_state(expires_at);
  `);
  const insert = database.prepare(`INSERT INTO better_auth_discourse_state (
    state_hash, browser_binding_hash, nonce, expires_at, operation, success_url, error_url,
    initiating_user_id, initiating_session_id, initiating_session_token_hash, integrity
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const consume = database.prepare(`DELETE FROM better_auth_discourse_state
    WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ? RETURNING *`);

  return {
    async insert(state: StoredTransactionState): Promise<void> {
      insert.run(
        state.stateHash,
        state.browserBindingHash,
        state.nonce,
        state.expiresAt,
        state.operation,
        state.successURL,
        state.errorURL,
        state.initiatingUserId ?? null,
        state.initiatingSessionId ?? null,
        state.initiatingSessionTokenHash ?? null,
        state.integrity,
      );
    },
    async consume({
      stateHash,
      browserBindingHash,
      now,
    }): Promise<StoredTransactionState | null> {
      const row = consume.get(stateHash, browserBindingHash, now) as
        Record<string, string | number | null> | undefined;
      if (!row) return null;
      return {
        stateHash: row.state_hash as string,
        browserBindingHash: row.browser_binding_hash as string,
        nonce: row.nonce as string,
        expiresAt: row.expires_at as number,
        operation: row.operation as StoredTransactionState["operation"],
        successURL: row.success_url as string,
        errorURL: row.error_url as string,
        ...(row.initiating_user_id === null
          ? {}
          : { initiatingUserId: row.initiating_user_id as string }),
        ...(row.initiating_session_id === null
          ? {}
          : { initiatingSessionId: row.initiating_session_id as string }),
        ...(row.initiating_session_token_hash === null
          ? {}
          : {
              initiatingSessionTokenHash:
                row.initiating_session_token_hash as string,
            }),
        integrity: row.integrity as string,
      };
    },
  };
}

/** Remove expired rows; safe to run periodically or at application startup. */
export function cleanupExpiredSqliteTransactionState(
  database: DatabaseSync,
  now = Date.now(),
): number {
  if (!Number.isFinite(now)) throw new Error("INVALID_STATE_TIME");
  return Number(
    database
      .prepare("DELETE FROM better_auth_discourse_state WHERE expires_at <= ?")
      .run(now).changes,
  );
}
