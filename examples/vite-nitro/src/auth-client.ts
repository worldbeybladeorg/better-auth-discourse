import { createAuthClient } from "better-auth/client";
import { discourseClient } from "better-auth-discourse/client";

// Same-origin calls preserve both session and Discourse transaction cookies.
// Never import the server plugin or expose secrets through VITE_* variables.
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [discourseClient()],
});
