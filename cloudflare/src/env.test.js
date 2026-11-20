import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { containerEnv } from "./env.js";
import { dispatchReady, notReadyResponse, probeHealth, waitForReady } from "./ready.js";

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
  assert.equal(container.rollout_step_percentage, 100);
  assert.equal(container.rollout_active_grace_period, 0);
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
  assert.equal(worker.includes("waitForReady("), true);
  assert.equal(worker.includes("notReadyResponse("), true);
  assert.equal(worker.includes("did not become ready"), false);
  assert.equal(worker.includes("dispatchReady("), true);
  assert.equal(worker.includes("HEALTH_PROBE_MS"), true);
  const start = worker.indexOf("() => container.getTcpPort");
  const forward = worker.slice(start, worker.indexOf(");", start));
  assert.equal(forward.includes("catch"), false);
  assert.equal(forward.includes("notReadyResponse"), false);
});

test("a closed port retries and then returns 503", async () => {
  let probes = 0;
  const ready = await waitForReady(
    async () => {
      probes += 1;
      if (probes < 3) throw new Error("connect");
      return "up";
    },
    async () => {},
    10_000,
    1,
  );
  assert.equal(ready, "up");
  assert.equal(probes, 3);

  const missed = await waitForReady(
    async () => false,
    async () => {},
    0,
    1_000,
  );
  assert.equal(missed, null);

  const response = notReadyResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "15");
});

test("503 is only returned before the client request is forwarded", async () => {
  let forwarded = 0;
  const closed = await dispatchReady(async () => false, async () => {
    forwarded += 1;
    return new Response("sent");
  });
  assert.equal(closed.status, 503);
  assert.equal(closed.headers.get("retry-after"), "15");
  assert.equal(forwarded, 0);

  const upstreamError = new Error("upstream failed after accept");
  await assert.rejects(
    () => dispatchReady(async () => true, async () => {
      throw upstreamError;
    }),
    (error) => error === upstreamError,
  );

  const upstream = new Response("no", { status: 500 });
  const passed = await dispatchReady(async () => true, async () => upstream);
  assert.equal(passed, upstream);
  assert.notEqual(passed.status, 503);
});

test("health probe stops when its timeout fires", async () => {
  const result = await Promise.race([
    probeHealth(
      (signal) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
      }),
      40,
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
  ]);
  assert.equal(result, false);

  let sawSignal = false;
  const ok = await probeHealth(async (signal) => {
    sawSignal = signal instanceof AbortSignal;
    return true;
  }, 1_000);
  assert.equal(ok, true);
  assert.equal(sawSignal, true);
  assert.equal(notReadyResponse().status, 503);
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
