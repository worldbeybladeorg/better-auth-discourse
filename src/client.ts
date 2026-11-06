import type { BetterAuthClientPlugin } from "better-auth/client";
import type { discourse } from "./index.js";

/**
 * Browser/client plugin for the DiscourseConnect server plugin.
 * The server import is type-only so this entry point never loads server code.
 */
export function discourseClient() {
  return {
    id: "discourse",
    $InferServerPlugin: {} as ReturnType<typeof discourse>,
    pathMethods: {
      "/sign-in/discourse": "POST",
      "/discourse/link": "POST",
    },
    $ERROR_CODES: {
      INVALID_REQUEST: {
        code: "INVALID_REQUEST",
        message: "The DiscourseConnect request is invalid.",
      },
      SESSION_REQUIRED: {
        code: "SESSION_REQUIRED",
        message: "An active local session is required to link Discourse.",
      },
    },
  } satisfies BetterAuthClientPlugin;
}
