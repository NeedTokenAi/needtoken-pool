import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

test("production wrangler config has no public route", () => {
  const config = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  const container = config.containers[0];
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const worker = readFileSync(join(root, "src/index.js"), "utf8");

  assert.equal(config.name, "needtoken-pool");
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.exports, undefined);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["PoolContainer"] },
  ]);
  assert.equal(config.preview_urls, false);
  assert.equal(config.vars.AUTO_SETUP, "true");
  assert.equal(config.vars.PORT, "8080");
  assert.equal(Object.hasOwn(config.vars, "REDIS_KEY_PREFIX"), false);
  assert.equal(Object.hasOwn(config.vars, "OPS_WRITES_ENABLED"), false);
  assert.equal(container.max_instances, 2);
  assert.equal(container.instance_type, "basic");
  assert.equal(container.scheduling_policy, "default");
  assert.equal(container.image, "../Dockerfile");
  assert.equal(container.image_build_context, "..");
  assert.deepEqual(container.constraints.regions, ["APAC"]);
  assert.deepEqual(config.observability, {
    enabled: true,
    logs: { enabled: true },
    head_sampling_rate: 1,
  });
  assert.deepEqual(Object.keys(config.vars).sort(), ["AUTO_SETUP", "PORT"]);
  assert.equal(text.includes("needtoken.ai"), false);
  assert.equal(text.includes("exports"), false);
  assert.equal(worker.includes('const RESIDENT_INSTANCE = "instance-0"'), true);
  assert.equal(worker.split("getByName(").length, 2);
  assert.equal(worker.includes("getByName(RESIDENT_INSTANCE)"), true);
  assert.equal(worker.includes("instance-1"), false);
  assert.equal(worker.includes("Math.random"), false);
  assert.equal(worker.includes("/health"), true);
  assert.equal(worker.includes("6 * 60 * 60 * 1000"), true);
});

test("deploy workflows do not build or ship a separate image", () => {
  const workflows = join(root, "../.github/workflows");
  assert.equal(existsSync(join(workflows, "cloudflare-staging-image.yml")), false);
  assert.equal(existsSync(join(workflows, "backend-ci.yml")), true);
  assert.equal(existsSync(join(workflows, "security-scan.yml")), true);

  const deployWorkflow = readdirSync(workflows)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => readFileSync(join(workflows, name), "utf8"))
    .find((text) => /gcloud|google-github-actions\/deploy-cloudrun|run\.googleapis\.com/.test(text));
  assert.equal(deployWorkflow, undefined);
});
