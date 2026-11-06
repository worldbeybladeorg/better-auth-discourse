import { defineHandler } from "nitro";
import { auth } from "../../auth.ts";

// Nitro v3 exposes a Web Request. Return Better Auth's Response untouched so
// redirects and every Set-Cookie header (including browser binding) survive.
export default defineHandler((event) => auth.handler(event.req));
