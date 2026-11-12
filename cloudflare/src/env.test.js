import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containerEnv } from "./env.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseJsonc(text) {
  const stripped = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(stripped);
}

test("container env is copied unchanged and omits bindings", () => {
  const passed = containerEnv({
    AUTO_SETUP: "true",
    DATABASE_HOST: "ep-production.example.neon.tech",
    DATABASE_PASSWORD: "secret-value",
    REDIS_PASSWORD: "redis-secret",
    POOL: { getByName() {} },
  });

  assert.deepEqual(passed, {
    AUTO_SETUP: "true",
    DATABASE_HOST: "ep-production.example.neon.tech",
    DATABASE_PASSWORD: "secret-value",
    REDIS_PASSWORD: "redis-secret",
  });
  assert.equal(Object.hasOwn(passed, "REDIS_KEY_PREFIX"), false);
});

test("production wrangler config stays on workers.dev", () => {
  const config = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  const container = config.containers[0];
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");

  assert.equal(config.name, "needtoken-pool");
  assert.equal(config.workers_dev, true);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.exports, undefined);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["PoolContainer"] },
  ]);
  assert.equal(config.vars.AUTO_SETUP, "true");
  assert.equal(Object.hasOwn(config.vars, "REDIS_KEY_PREFIX"), false);
  assert.equal(Object.hasOwn(config.vars, "OPS_WRITES_ENABLED"), false);
  assert.equal(container.max_instances, 2);
  assert.equal(container.instance_type.vcpu, 1);
  assert.equal(container.instance_type.memory_mib, 512);
  assert.equal(container.image.includes("Dockerfile"), false);
  assert.equal(container.image.includes("needtoken-pool-staging"), false);
  assert.match(container.image, /^registry\.cloudflare\.com\/ACCOUNT_ID\/needtoken-pool@sha256:DIGEST$/);
  assert.equal(text.includes("needtoken.ai"), false);
  assert.equal(text.includes("exports"), false);
});

test("image workflow records a production digest without an account id", () => {
  const workflow = readFileSync(
    join(root, "../.github/workflows/cloudflare-staging-image.yml"),
    "utf8",
  );

  assert.match(workflow, /needtoken-pool:\$\{tag\}/);
  assert.equal(workflow.includes("needtoken-pool-staging"), false);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /image-record\.json/);
  assert.equal(workflow.includes("workflow_dispatch"), true);
  assert.equal(workflow.includes("pull_request:"), false);
});
