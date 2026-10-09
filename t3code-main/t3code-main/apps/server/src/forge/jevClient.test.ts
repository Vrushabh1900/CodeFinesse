import { assert, it } from "@effect/vitest";

import { askJevChoice, readJevConfig, type JevConfig } from "./jevClient.ts";

const config: JevConfig = {
  baseUrl: "https://jev.example",
  apiKey: "apik_super_secret_value_1234567890",
  model: "jev-latest",
  timeoutMs: 500,
};
const question = { id: "route", instructions: "Pick one", criteria: { a: "A", b: "B" } };

const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

it("returns the choice and probabilities from a Jev response", async () => {
  let request: { url: string; auth: string | null; body: any } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    request = {
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    };
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { route: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } } },
      }),
    );
  }) as unknown as typeof fetch;

  const result = await askJevChoice(config, "state", question, fetchImpl);
  assert.isTrue(result.ok);
  if (!result.ok) return;
  assert.equal(result.choice, "b");
  assert.equal(result.probabilities.b, 0.9);
  assert.equal(result.modelId, "jev-1.13.0");
  assert.equal(request?.url, "https://jev.example/v1/systemone");
  assert.equal(request?.auth, `Bearer ${config.apiKey}`);
  assert.equal(request?.body.questions.route.type, "choice");
});

it("reports an HTTP error without leaking the key", async () => {
  const result = await askJevChoice(config, "s", question, reply({ detail: "nope" }, 401));
  assert.isFalse(result.ok);
  if (result.ok) return;
  assert.equal(result.reason, "http_401");
  assert.isFalse(JSON.stringify(result).includes(config.apiKey));
});

it("reports a malformed body as an unexpected shape", async () => {
  const result = await askJevChoice(config, "s", question, reply({ answers: {} }));
  assert.isFalse(result.ok);
  if (result.ok) return;
  assert.equal(result.reason, "unexpected_response_shape");
});

it("reports a network failure without throwing", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const result = await askJevChoice(config, "s", question, fetchImpl);
  assert.isFalse(result.ok);
  if (result.ok) return;
  assert.equal(result.reason, "network_error");
});

it("reads configuration only when a key is present", () => {
  assert.isNull(readJevConfig({}));
  assert.isNull(readJevConfig({ JEV_API_KEY: "  " }));
  const read = readJevConfig({ JEV_API_KEY: "k", JEV_BASE_URL: "https://x.test///" });
  assert.equal(read?.baseUrl, "https://x.test");
  assert.equal(read?.model, "jev-latest");
});
