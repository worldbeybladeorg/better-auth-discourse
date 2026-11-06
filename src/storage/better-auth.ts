import type {
  StoredTransactionState,
  TransactionStateStorage,
} from "../state.js";

type AdapterWhere = {
  field: string;
  value: string | number;
  operator?: "eq" | "gt";
};

/** The narrow public `ctx.context.adapter` surface needed by this store.
 * Better Auth 1.7.18 factory-wrapped adapters expose atomic `consumeOne`. */
export interface BetterAuthStateAdapter {
  create<T>(input: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<T>;
  consumeOne<T>(input: {
    model: string;
    where: AdapterWhere[];
  }): Promise<T | null>;
}

/** Adapt a Better Auth endpoint context's `context.adapter` to transaction state.
 * The server plugin must register `transactionStateSchema` and host migrations
 * must apply that plugin-owned model before endpoints are served. */
export function createBetterAuthTransactionStateStorage(
  adapter: BetterAuthStateAdapter,
): TransactionStateStorage {
  if (
    !adapter ||
    typeof adapter.create !== "function" ||
    typeof adapter.consumeOne !== "function"
  ) {
    throw new Error("UNSUPPORTED_BETTER_AUTH_STATE_ADAPTER");
  }
  return {
    async insert(state: StoredTransactionState): Promise<void> {
      await adapter.create({
        model: "discourseConnectState",
        data: {
          stateHash: state.stateHash,
          browserBindingHash: state.browserBindingHash,
          nonce: state.nonce,
          expiresAt: state.expiresAt,
          operation: state.operation,
          successURL: state.successURL,
          errorURL: state.errorURL,
          initiatingUserId: state.initiatingUserId ?? null,
          initiatingSessionId: state.initiatingSessionId ?? null,
          initiatingSessionTokenHash: state.initiatingSessionTokenHash ?? null,
          integrity: state.integrity,
        },
      });
    },
    async consume({
      stateHash,
      browserBindingHash,
      now,
    }): Promise<StoredTransactionState | null> {
      const row = await adapter.consumeOne<StoredTransactionState>({
        model: "discourseConnectState",
        where: [
          { field: "stateHash", value: stateHash },
          { field: "browserBindingHash", value: browserBindingHash },
          { field: "expiresAt", operator: "gt", value: now },
        ],
      });
      return row;
    },
  };
}
