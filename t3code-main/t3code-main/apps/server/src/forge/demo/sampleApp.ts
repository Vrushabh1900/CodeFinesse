/**
 * The demo project Forge missions run against: a small dependency-free Node
 * app with a JWT sign-in route and real `node:test` tests. It is written to
 * disk at demo start so scanning, "agent" edits and the test run all touch
 * real files.
 */
export const SAMPLE_APP_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    { name: "forge-sample-app", private: true, scripts: { test: "node --test" } },
    null,
    2,
  ),
  "server/auth/jwt.js": `const crypto = require("node:crypto");

const SECRET = "demo-only-secret";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(claims) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  const mac = crypto.createHmac("sha256", SECRET).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + mac;
}

function verify(token) {
  const [head, body, mac] = String(token).split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(head + "." + body).digest("base64url");
  if (mac !== expected) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

module.exports = { sign, verify };
`,
  "server/routes/login.js": `const { sign } = require("../auth/jwt");

module.exports = function login(body) {
  if (body.user === "demo" && body.password === "demo") {
    return { status: 200, body: { token: sign({ sub: "demo" }) } };
  }
  return { status: 401, body: { error: "invalid credentials" } };
};
`,
  "server/index.js": `const login = require("./routes/login");

const routes = {
  "POST /auth/login": login,
};

module.exports = { routes };
`,
  "web/api.js": `module.exports = {
  async postJson(path, body) {
    const { routes } = require("../server");
    const handler = routes["POST " + path];
    return handler ? handler(body) : { status: 404, body: {} };
  },
};
`,
  "web/LoginForm.js": `const { postJson } = require("./api");

module.exports = function LoginForm() {
  return {
    submit: (user, password) => postJson("/auth/login", { user, password }),
  };
};
`,
  "tests/auth.test.js": `const test = require("node:test");
const assert = require("node:assert");
const { sign, verify } = require("../server/auth/jwt");
const { routes } = require("../server");

test("jwt round trip", () => {
  assert.equal(verify(sign({ sub: "a" })).sub, "a");
});

test("login issues a verifiable token", () => {
  const res = routes["POST /auth/login"]({ user: "demo", password: "demo" });
  assert.equal(res.status, 200);
  assert.equal(verify(res.body.token).sub, "demo");
});
`,
};
