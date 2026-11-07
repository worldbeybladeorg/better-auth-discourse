import { createAuthClient } from "better-auth/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { discourseClient } from "better-auth-discourse/client";
import type { auth } from "../server/auth.ts";

// Same-origin calls preserve both session and Discourse transaction cookies.
// The server reference is type-only; never bundle it or expose VITE_* secrets.
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [discourseClient(), inferAdditionalFields<typeof auth>()],
});
