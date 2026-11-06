import { APIError } from "better-auth/api";

/** Stable public codes used for expected DiscourseConnect endpoint failures. */
export const DISCOURSE_ERROR_CODES = {
  INVALID_REQUEST: "The DiscourseConnect request is invalid.",
  SESSION_REQUIRED: "An active local session is required to link Discourse.",
  INVALID_RESPONSE: "The DiscourseConnect response is invalid.",
  INVALID_STATE: "The DiscourseConnect transaction is invalid or expired.",
} as const;

export type DiscourseErrorCode = keyof typeof DISCOURSE_ERROR_CODES;

export function discourseAPIError(code: DiscourseErrorCode): APIError {
  const status = code === "SESSION_REQUIRED" ? "UNAUTHORIZED" : "BAD_REQUEST";
  return new APIError(status, { code, message: DISCOURSE_ERROR_CODES[code] });
}
