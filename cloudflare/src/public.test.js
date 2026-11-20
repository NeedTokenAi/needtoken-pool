import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { default: worker, forwardedRequest } = await import("./index.js");

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(join(here, "index.js"), "utf8");
const wranglerSource = readFileSync(join(here, "../wrangler.jsonc"), "utf8");

function authorizationOf(request) {
  return request.headers.get("authorization");
}

test("forwardedRequest does not add or rewrite Authorization", () => {
  const cases = [
    { name: "missing key", authorization: null },
    { name: "bearer form", authorization: "Bearer sk-example" },
    { name: "invalid basic form", authorization: "Basic dXNlcjpwYXNz" },
    { name: "invalid raw form", authorization: "sk-example" },
  ];

  for (const item of cases) {
    const headers = { "x-request-id": "req-1" };
    if (item.authorization !== null) headers.authorization = item.authorization;
    const request = new Request("https://pool.example/v1/chat/completions", {
      method: "POST",
      headers,
    });
    const forwarded = forwardedRequest(request);

    assert.equal(authorizationOf(forwarded), item.authorization, item.name);
    assert.equal(forwarded.headers.get("x-request-id"), "req-1", item.name);
    assert.equal(new URL(forwarded.url).host, "container", item.name);
  }
});

test("forwardedRequest leaves a non-Authorization credential header untouched", () => {
  const request = new Request("https://pool.example/v1/messages", {
    headers: { "x-api-key": "sk-example", "x-goog-api-key": "goog-example" },
  });
  const forwarded = forwardedRequest(request);

  assert.equal(authorizationOf(forwarded), null);
  assert.equal(forwarded.headers.get("x-api-key"), "sk-example");
  assert.equal(forwarded.headers.get("x-goog-api-key"), "goog-example");
});

test("worker source does not admit by Authorization, /api/, or a forged internal header", () => {
  assert.equal(/authorization/i.test(workerSource), false);
  assert.equal(workerSource.includes("/api/"), false);
  assert.equal(/x-internal|x-admin|cf-access/i.test(workerSource), false);
  assert.equal(workerSource.includes("INTERNAL_"), false);
  assert.equal(workerSource.includes("enableInternet: true"), true);
  assert.equal(workerSource.includes("interceptOutboundHttps"), false);
  assert.equal(wranglerSource.includes("interceptOutboundHttps"), false);
  assert.equal(wranglerSource.includes('"services"'), false);
  assert.equal(wranglerSource.includes("INTERNAL_"), false);
});

test("public fetch sends admin and gateway paths to instance-0", async () => {
  const paths = [
    "/api/v1/admin/accounts",
    "/api/v1/auth/login",
    "/v1/chat/completions",
    "/v1beta/models/gemini:generateContent",
    "/v1/stt",
    "/images/edits",
  ];
  const authorizations = [null, "Bearer sk-example", "Basic dXNlcjpwYXNz"];
  const internalCalls = [];

  function binding(name) {
    return {
      async fetch() {
        internalCalls.push(name);
        throw new Error(`public fetch called ${name}`);
      },
    };
  }

  for (const path of paths) {
    for (const authorization of authorizations) {
      const seen = [];
      const headers = {
        "x-internal-admin": "true",
        "x-internal-target": "admin",
      };
      if (authorization !== null) headers.authorization = authorization;
      const env = {
        POOL: {
          getByName(name) {
            return {
              async fetch(request) {
                seen.push({
                  name,
                  path: new URL(request.url).pathname,
                  authorization: authorizationOf(request),
                  forged: request.headers.get("x-internal-admin"),
                });
                return new Response("forwarded", { status: 200 });
              },
            };
          },
        },
        INTERNAL_POOL: binding("INTERNAL_POOL"),
        INTERNAL_API: binding("INTERNAL_API"),
        INTERNAL_GLUE: binding("INTERNAL_GLUE"),
        INTERNAL_STOREFRONT: binding("INTERNAL_STOREFRONT"),
      };

      const response = await worker.fetch(
        new Request(`https://pool.example${path}`, { method: "POST", headers }),
        env,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(seen, [
        {
          name: "instance-0",
          path,
          authorization,
          forged: "true",
        },
      ]);
    }
  }

  assert.deepEqual(internalCalls, []);
});
