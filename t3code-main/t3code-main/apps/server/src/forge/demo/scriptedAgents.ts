/**
 * Deterministic stand-ins for coding agents, used only by the demo. They are
 * not an LLM and the dashboard says so. What they do is real: they read the
 * prompt Forge gave them and write real files, so retrieved decisions and the
 * acknowledged contract change what ends up on disk.
 */
import { parseContract, type Contract } from "../contract.ts";
import { readText, writeFiles } from "./workspaces.ts";

export const DEFAULT_CONTRACT: Contract = {
  endpoint: "POST /auth/google-mock",
  response: { token: "string", provider: "string" },
};

const CONTRACT_MARKER = "implement against it exactly):\n";

/** Pulls the acknowledged contract out of an agent prompt, or null if there is none. */
export function contractFromPrompt(prompt: string): Contract | null {
  const at = prompt.indexOf(CONTRACT_MARKER);
  if (at === -1) return null;
  try {
    return parseContract(JSON.parse(prompt.slice(at + CONTRACT_MARKER.length)));
  } catch {
    return null;
  }
}

/** True when the prompt carries the developer decision to keep the existing auth service. */
export const promptReusesAuth = (prompt: string) =>
  /existing auth service|do not introduce auth0/i.test(prompt);

function patch(root: string, path: string, from: string, to: string): Record<string, string> {
  const content = readText(root, path);
  if (!content.includes(from)) throw new Error(`Expected text not found in ${path}`);
  return { [path]: content.replace(from, to) };
}

export function applyBackendWork(root: string, prompt: string, contract: Contract): string[] {
  const [, routePath = "/auth/google-mock"] = contract.endpoint.split(" ");
  const reuse = promptReusesAuth(prompt);
  const authModule = reuse ? "../auth/jwt" : "../auth/auth0Client";
  const files: Record<string, string> = {
    "server/routes/googleMock.js": `const { sign } = require("${authModule}");

// Mock only: this does not talk to Google.
module.exports = function googleMock() {
  return { status: 200, body: { token: sign({ sub: "mock-google-user" }), provider: "google-mock" } };
};
`,
    "tests/googleMock.test.js": `const test = require("node:test");
const assert = require("node:assert");
const { routes } = require("../server");

test("mock google route issues a token", () => {
  const res = routes["POST ${routePath}"]({});
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, "google-mock");
  assert.ok(res.body.token);
});
`,
    ...patch(
      root,
      "server/index.js",
      `const login = require("./routes/login");

const routes = {
  "POST /auth/login": login,
};`,
      `const login = require("./routes/login");
const googleMock = require("./routes/googleMock");

const routes = {
  "POST /auth/login": login,
  "POST ${routePath}": googleMock,
};`,
    ),
  };
  if (!reuse) {
    files["server/auth/auth0Client.js"] = `// A second, parallel auth path: the agent had no project decision telling it to reuse jwt.js.
module.exports = { sign: (claims) => "auth0-stub." + Buffer.from(JSON.stringify(claims)).toString("base64url") };
`;
  }
  writeFiles(root, files);
  return Object.keys(files);
}

export function applyFrontendWork(root: string, contract: Contract): string[] {
  const [, routePath = "/auth/google-mock"] = contract.endpoint.split(" ");
  const files: Record<string, string> = {
    "web/GoogleButton.js": `const { postJson } = require("./api");

module.exports = function GoogleButton() {
  return {
    label: "Sign in with Google (mock)",
    click: () => postJson("${routePath}", {}),
  };
};
`,
    "tests/googleButton.test.js": `const test = require("node:test");
const assert = require("node:assert");
const LoginForm = require("../web/LoginForm");

test("login form exposes a working mock google button", async () => {
  const res = await LoginForm().googleButton.click();
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});
`,
    ...patch(
      root,
      "web/LoginForm.js",
      `const { postJson } = require("./api");

module.exports = function LoginForm() {
  return {
    submit:`,
      `const { postJson } = require("./api");
const GoogleButton = require("./GoogleButton");

module.exports = function LoginForm() {
  return {
    googleButton: GoogleButton(),
    submit:`,
    ),
  };
  writeFiles(root, files);
  return Object.keys(files);
}
