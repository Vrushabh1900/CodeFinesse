import { assert, it } from "@effect/vitest";

import { REDACTED, redactPayload, redactText } from "./redact.ts";

it("scrubs bearer tokens, key assignments and vendor-prefixed secrets from text", () => {
  const text = "Authorization: Bearer abcdef1234567890 and JEV_API_KEY=apik_abcdefghijklmnop1234";
  const out = redactText(text);
  assert.isFalse(out.includes("abcdef1234567890"));
  assert.isFalse(out.includes("apik_abcdefghijklmnop1234"));
  assert.isTrue(out.includes(REDACTED));
});

it("leaves ordinary prose alone", () => {
  const text = "Add a login form to the React app and a /auth/google route.";
  assert.equal(redactText(text), text);
});

it("scrubs sensitive keys and nested strings in payloads", () => {
  const out = redactPayload({
    command: "pnpm test",
    apiKey: "plain-looking-value",
    nested: { password: "hunter2", note: "token=zzzzzzzz9999", list: ["ok", "Bearer qqqqqqqq1111"] },
  }) as any;
  assert.equal(out.command, "pnpm test");
  assert.equal(out.apiKey, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.isFalse(out.nested.note.includes("zzzzzzzz9999"));
  assert.isFalse(out.nested.list[1].includes("qqqqqqqq1111"));
});

it("keeps API contract schemas readable while still hiding credential-shaped values", () => {
  const out = redactPayload({
    contract: {
      endpoint: "POST /auth/google-mock",
      response: {
        token: "string",
        tokenDescription: "JWT signed with the existing auth service",
        refresh_token: { type: "string" },
      },
    },
    leaked: { token: "abcdEFGH12345678" },
  }) as any;
  assert.equal(out.contract.response.token, "string");
  assert.equal(out.contract.response.tokenDescription, "JWT signed with the existing auth service");
  assert.deepEqual(out.contract.response.refresh_token, { type: "string" });
  assert.equal(out.leaked.token, REDACTED);
});
