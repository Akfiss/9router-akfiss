// Bansos Gateway — representative secret samples for prompt-audit redaction
// tests (Task 10). Each TEXT_PATTERN sample below is designed to trip the
// *text-pattern* (defense-in-depth) layer of redactBansosSecrets — i.e. the
// secret is embedded in a plain string value, NOT under a suspiciously-named
// object key, so a test using these fixtures only passes if the regex-based
// scanning layer actually works (structural key-name redaction wouldn't
// catch these at all, by design).
//
// NESTED_SECRET_OBJECT exercises the *structural* layer: property names
// matching password|secret|credential|api[_-]?key|token at various nesting
// depths, with values that don't necessarily look like secrets themselves —
// proving the structural layer redacts on name alone, "regardless of what
// the value looks like" (per the task brief).

// -- Bearer token --------------------------------------------------------
export const BEARER_TOKEN_SAMPLE = "Authorization: Bearer sk-live-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";

// -- bns_-prefixed key (Bansos's own key format, see keyService.js) ------
export const BNS_KEY_SAMPLE = "bns_a1b2c3d4e5f60000000000000000000000000000000000";

// -- sk-prefixed key (generic OpenAI-style API key) ----------------------
export const SK_KEY_SAMPLE = "sk-proj-A1B2c3D4e5F6G7h8I9J0K1L2M3N4O5P6Q7R8S9T0";

// -- JWT: three base64url segments separated by dots (no valid signature
// required — just needs to structurally look like a JWT) ----------------
export const JWT_SAMPLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0" +
  ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

// -- PEM private key block -------------------------------------------------
export const PEM_PRIVATE_KEY_SAMPLE = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAwahvI9Kd1qN9bMHo",
  "wZK3PQZlyzXhI3jJXO8N1YuT4rQpQvKzPqZs5cq3FvHnE1TgxvKzq9J4kQyM9k3g",
  "AgMBAAECQQCHZWZ2z0/example/base64/body/not/a/real/key/material==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

// -- Cookie / Set-Cookie header strings -----------------------------------
export const COOKIE_HEADER_SAMPLE = "Cookie: session_id=abc123def456; theme=dark";
export const SET_COOKIE_HEADER_SAMPLE = "Set-Cookie: sessionid=zzz111yyy222; Path=/; HttpOnly";

// -- access_token / refresh_token shaped values embedded in free text,
// where the property name itself would NOT match the structural layer
// (this is plain prose, not a JSON object key) ----------------------------
export const ACCESS_TOKEN_FREE_TEXT_SAMPLE =
  'The upstream call returned access_token: "aT0kEnValue1234567890abcdef" in the body.';
export const REFRESH_TOKEN_FREE_TEXT_SAMPLE =
  "Please rotate refresh_token=rT0kEnValue0987654321zyxwvu before it expires.";

// Flat list of every text-pattern category, for data-driven tests.
export const TEXT_PATTERN_SECRET_SAMPLES = [
  { name: "bearer token", raw: "sk-live-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", text: BEARER_TOKEN_SAMPLE },
  { name: "bns_-prefixed key", raw: BNS_KEY_SAMPLE, text: `My Bansos key is ${BNS_KEY_SAMPLE} — keep it safe.` },
  { name: "sk-prefixed key", raw: SK_KEY_SAMPLE, text: `Use this key: ${SK_KEY_SAMPLE} for the API call.` },
  { name: "JWT", raw: JWT_SAMPLE, text: `Session JWT: ${JWT_SAMPLE}` },
  { name: "PEM private key block", raw: "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAwahvI9Kd1qN9bMHo", text: PEM_PRIVATE_KEY_SAMPLE },
  { name: "Cookie header", raw: "session_id=abc123def456", text: COOKIE_HEADER_SAMPLE },
  { name: "Set-Cookie header", raw: "sessionid=zzz111yyy222", text: SET_COOKIE_HEADER_SAMPLE },
  { name: "access_token in free text", raw: "aT0kEnValue1234567890abcdef", text: ACCESS_TOKEN_FREE_TEXT_SAMPLE },
  { name: "refresh_token in free text", raw: "rT0kEnValue0987654321zyxwvu", text: REFRESH_TOKEN_FREE_TEXT_SAMPLE },
];

// -- Structural layer: property names matching the secret-key regex at
// various nesting depths. Values are deliberately innocuous-looking
// (no bearer/JWT/etc. shape) to prove redaction happens on NAME alone.
export const NESTED_SECRET_OBJECT_SAMPLE = {
  role: "user",
  password: "hunter2-not-a-real-password",
  profile: {
    apiKey: "innocuous-looking-value-1",
    nested: {
      "api-key": "innocuous-looking-value-2",
      api_key: "innocuous-looking-value-3",
      credential: {
        // Whole subtree must be replaced wholesale — layer 1 must not
        // recurse INTO a matched key's value.
        type: "oauth",
        clientSecret: "should-never-surface-either-way",
      },
      secret: "plain-secret-value",
      user_token: "plain-token-value",
      refreshToken: "plain-refresh-value",
    },
  },
  // A sibling, non-matching key must survive untouched.
  content: "hello, this part is not sensitive",
};

export const TRUNCATION_MARKER = "...[TRUNCATED]";
