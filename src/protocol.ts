/**
 * DiscourseConnect wire format, based on Discourse at
 * 5c954dc77fef0d7600e3a92be40acca3fab8d9e0:
 * lib/discourse_connect_base.rb (payload/signing) and
 * lib/second_factor/actions/discourse_connect_provider.rb (provider claims).
 * Recheck against the deployed Discourse version before release.
 */

export const discourseConnectProfile = {
  // Limits apply to UTF-8 bytes except key/value/nonce lengths, which are
  // decoded Unicode code units (and are additionally covered by byte limits).
  maxRequestBytes: 24_576,
  maxDecodedBytes: 12_288,
  maxParameters: 64,
  maxKeyLength: 128,
  maxValueLength: 4_096,
  maxNonceLength: 512,
} as const;

export type DiscourseConnectProfile = typeof discourseConnectProfile;

export type DiscourseConnectFailureCode =
  | "INVALID_INPUT"
  | "PAYLOAD_TOO_LARGE"
  | "MALFORMED_QUERY"
  | "DUPLICATE_PARAMETER"
  | "INVALID_BASE64"
  | "INVALID_SIGNATURE"
  | "MISSING_CLAIM"
  | "AUTHENTICATION_FAILED";

export class DiscourseConnectProtocolError extends Error {
  constructor(readonly code: DiscourseConnectFailureCode) {
    // Do not include secrets or authentication payloads in error messages.
    super(code);
    this.name = "DiscourseConnectProtocolError";
  }
}

export interface CreateDiscourseConnectRequestOptions {
  discourseURL: string;
  returnSSOURL: string;
  nonce: string;
  secret: string;
}

export interface DiscourseConnectRequest {
  authorizationURL: string;
  payload: string;
  signature: string;
}

export interface DiscourseConnectClaims {
  nonce: string;
  external_id: string;
  email: string;
  failed?: boolean;
  username?: string;
  name?: string;
  avatar_url?: string;
  bio?: string;
  location?: string;
  title?: string;
  website?: string;
  groups?: string;
  admin?: boolean;
  moderator?: boolean;
  profile_background_url?: string;
  card_background_url?: string;
  confirmed_2fa?: boolean;
  no_2fa_methods?: boolean;
}

function fail(code: DiscourseConnectFailureCode): never {
  throw new DiscourseConnectProtocolError(code);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function source(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return fail("INVALID_BASE64");
  }
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (base64(bytes) !== value) return fail("INVALID_BASE64");
    return bytes;
  } catch {
    return fail("INVALID_BASE64");
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    source(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, source(utf8(data))),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function parseQuery(
  query: string,
  limit: number,
  maxValueLength: number = discourseConnectProfile.maxValueLength,
): Map<string, string> {
  if (utf8(query).byteLength > limit) return fail("PAYLOAD_TOO_LARGE");
  if (query === "") return new Map();
  const parts = query.split("&");
  if (parts.length > discourseConnectProfile.maxParameters)
    return fail("PAYLOAD_TOO_LARGE");
  const result = new Map<string, string>();
  for (const part of parts) {
    if (!part) return fail("MALFORMED_QUERY");
    const separator = part.indexOf("=");
    if (separator < 1) return fail("MALFORMED_QUERY");
    const decode = (value: string): string => {
      try {
        return decodeURIComponent(value.replace(/\+/g, " "));
      } catch {
        return fail("MALFORMED_QUERY");
      }
    };
    const key = decode(part.slice(0, separator));
    const value = decode(part.slice(separator + 1));
    if (
      !key ||
      key.length > discourseConnectProfile.maxKeyLength ||
      value.length > maxValueLength
    ) {
      return fail("MALFORMED_QUERY");
    }
    if (result.has(key)) return fail("DUPLICATE_PARAMETER");
    result.set(key, value);
  }
  return result;
}

function required(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined || value.length === 0) return fail("MISSING_CLAIM");
  return value;
}

/** Create the signed query and authorization URL sent to Discourse. */
export async function createDiscourseConnectRequest(
  options: CreateDiscourseConnectRequestOptions,
): Promise<DiscourseConnectRequest> {
  for (const value of [
    options.discourseURL,
    options.returnSSOURL,
    options.nonce,
    options.secret,
  ]) {
    if (typeof value !== "string" || value.length === 0)
      return fail("INVALID_INPUT");
  }
  const validHttpURL = (value: string): boolean => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname !== "" &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  };
  if (
    !validHttpURL(options.discourseURL) ||
    !validHttpURL(options.returnSSOURL)
  )
    return fail("INVALID_INPUT");
  if (
    utf8(options.nonce).byteLength > discourseConnectProfile.maxNonceLength ||
    utf8(options.returnSSOURL).byteLength >
      discourseConnectProfile.maxValueLength
  )
    return fail("PAYLOAD_TOO_LARGE");
  // Rack's build_query convention: values are UTF-8 form encoded, then the
  // Base64 text is signed verbatim (not its percent-encoded outer form).
  const unsigned = `nonce=${encodeURIComponent(options.nonce).replace(/%20/g, "+")}&return_sso_url=${encodeURIComponent(options.returnSSOURL).replace(/%20/g, "+")}`;
  if (utf8(unsigned).byteLength > discourseConnectProfile.maxDecodedBytes)
    return fail("PAYLOAD_TOO_LARGE");
  const encoded = base64(utf8(unsigned));
  const signature = hex(await hmac(options.secret, encoded));
  const query = `sso=${encodeURIComponent(encoded)}&sig=${signature}`;
  if (utf8(query).byteLength > discourseConnectProfile.maxRequestBytes)
    return fail("PAYLOAD_TOO_LARGE");
  const authorizationURL = new URL(
    "/session/sso_provider",
    options.discourseURL,
  );
  authorizationURL.search = query;
  return {
    authorizationURL: authorizationURL.toString(),
    payload: encoded,
    signature,
  };
}

/** Verify the exact Base64 text's HMAC before decoding or interpreting claims. */
export async function verifyDiscourseConnectResponse(
  query: string,
  secret: string,
): Promise<DiscourseConnectClaims> {
  if (
    typeof query !== "string" ||
    typeof secret !== "string" ||
    secret.length === 0
  )
    return fail("INVALID_INPUT");
  const outer = parseQuery(
    query,
    discourseConnectProfile.maxRequestBytes,
    discourseConnectProfile.maxRequestBytes,
  );
  const encoded = required(outer, "sso");
  const signature = required(outer, "sig");
  if ([...outer.keys()].some((key) => key !== "sso" && key !== "sig"))
    return fail("MALFORMED_QUERY");
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return fail("INVALID_SIGNATURE");

  const key = await crypto.subtle.importKey(
    "raw",
    source(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = Uint8Array.from(signature.match(/../g)!, (byte) =>
    Number.parseInt(byte, 16),
  );
  // Crucially, no Base64 decoding or claim parsing occurs before this check.
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      source(signatureBytes),
      source(utf8(encoded)),
    ))
  )
    return fail("INVALID_SIGNATURE");

  const bytes = decodeBase64(encoded);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("MALFORMED_QUERY");
  }
  if (bytes.byteLength > discourseConnectProfile.maxDecodedBytes)
    return fail("PAYLOAD_TOO_LARGE");
  const claimsMap = parseQuery(
    decoded,
    discourseConnectProfile.maxDecodedBytes,
  );
  if (claimsMap.get("failed") === "true") return fail("AUTHENTICATION_FAILED");
  const nonce = required(claimsMap, "nonce");
  const external_id = required(claimsMap, "external_id");
  const email = required(claimsMap, "email");

  const claims: DiscourseConnectClaims = { nonce, external_id, email };
  const booleanValue = claimsMap.get("failed");
  if (booleanValue !== undefined) {
    if (booleanValue !== "true" && booleanValue !== "false")
      return fail("MALFORMED_QUERY");
    claims.failed = booleanValue === "true";
  }
  for (const name of [
    "username",
    "name",
    "avatar_url",
    "bio",
    "location",
    "title",
    "website",
    "groups",
    "profile_background_url",
    "card_background_url",
  ] as const) {
    const value = claimsMap.get(name);
    if (value !== undefined) claims[name] = value;
  }
  for (const name of [
    "admin",
    "moderator",
    "confirmed_2fa",
    "no_2fa_methods",
  ] as const) {
    const value = claimsMap.get(name);
    if (value !== undefined) {
      if (value !== "true" && value !== "false") return fail("MALFORMED_QUERY");
      claims[name] = value === "true";
    }
  }
  return claims;
}
