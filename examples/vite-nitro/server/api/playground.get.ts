import { defineHandler } from "nitro";
import { linkingEnabled } from "../auth.ts";

// Only public capabilities, never environment variables or shared secrets.
export default defineHandler(() => ({ linkingEnabled }));
