import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertStagingImageConfig, bindCandidate, selfTest } from "../candidate-check.mjs";
import {
  INACTIVITY_TIMEOUT_MS,
  INSTANCE,
  LIMITS,
  READINESS_WAIT_MS,
  SIGTERM,
  SINGLETON_NAME,
  WATCHDOG_INTERVAL_MS,
  containerEnv,
  containerRequest,
  createSession,
  handleRequest,
  planRecovery,
  sessionFromContainer,
  proxyResponse,
  resolveSingletonId,
  schedulerWait,
  singletonName,
  startOptions,
} from "./runtime.js";

const SHA = "a".repeat(40);
const PREVIOUS_SHA = "b".repeat(40);
const RUN_ID = "43174764702";
const IMAGE = `registry.cloudflare.com/example-account/needtoken-pool@sha256:${"ab".repeat(32)}`;
const PREVIOUS = `registry.cloudflare.com/example-account/needtoken-pool@sha256:${"cd".repeat(32)}`;
const REPO = "NeedTokenAi/needtoken-pool";

function isolatedEnv(overrides = {}) {
  return {
    SUB2API_ISOLATION: "isolated",
    SUB2API_WRITER_PERMIT: "pool-writer-permit-fixture",
    DATABASE_HOST: "ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.tech",
    REDIS_HOST: "existing-upstash.example",
    SUB2API_BACKGROUND_CONSUMERS: "off",
    REDIS_KEY_PREFIX: "staging:",
    CONFIG_FILE: "/app/data/config.yaml",
    DATA_DIR: "/app/data",
    STAGING_TEST_JWT_SECRET: "staging-test-jwt-secret-not-production",
    STAGING_TEST_TOTP_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    POOL_BUILD_REPOSITORY: REPO,
    POOL_BUILD_SHA: SHA,
    POOL_BUILD_RUN_ID: RUN_ID,
    POOL_BUILD_DIGEST: IMAGE,
    JWT_SECRET: "fixture-value",
    ...overrides,
  };
}

function approvedFor(env = isolatedEnv()) {
  const gate = sessionFromContainer({ container: { images: { pool: env.POOL_BUILD_DIGEST } } }, env);
  return gate.approved;
}

function memoryStorage() {
  const values = new Map();
  const alarms = [];
  return {
    alarms,
    async put(key, value) {
      values.set(key, value);
    },
    async get(key) {
      return values.get(key);
    },
    async setAlarm(timestamp) {
      alarms.push(timestamp);
    },
  };
}

function fakeContainer() {
  let running = false;
  const signals = [];
  let started = null;
  let starts = 0;
  const timeouts = [];
  const container = {
    signals,
    timeouts,
    images: { pool: IMAGE },
    failStart: false,
    exitCode: 0,
    get running() {
      return running;
    },
    set running(value) {
      running = value;
    },
    get starts() {
      return starts;
    },
    start(options) {
      if (container.failStart) {
        throw new Error("start failed");
      }
      if (running) {
        throw new Error("already running");
      }
      started = options;
      starts += 1;
      running = true;
    },
    started: () => started,
    async setInactivityTimeout(ms) {
      timeouts.push(ms);
    },
    signal(number) {
      signals.push(number);
    },
    async monitor() {
      if (container.exitCode !== 0) {
        const error = new Error("container exited");
        error.exitCode = container.exitCode;
        throw error;
      }
      running = false;
    },
  };
  return container;
}

function healthPort(statuses, stream) {
  let healthCalls = 0;
  let seen;
  return {
    get healthCalls() {
      return healthCalls;
    },
    get seen() {
      return seen;
    },
    async fetch(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/health")) {
        const status = statuses[Math.min(healthCalls, statuses.length - 1)];
        healthCalls += 1;
        if (status === "ECONNREFUSED") {
          const error = new Error("connect ECONNREFUSED 127.0.0.1");
          error.code = "ECONNREFUSED";
          throw error;
        }
        return {
          status,
          ok: status === 200,
          body: { cancel: async () => {} },
          init,
        };
      }
      seen = input;
      return {
        status: 200,
        ok: true,
        headers: { "content-type": "text/event-stream" },
        body: stream,
        init,
      };
    },
  };
}

function sessionWith(overrides = {}) {
  const container = overrides.container ?? fakeContainer();
  const storage = overrides.storage ?? memoryStorage();
  const port = overrides.port ?? healthPort([200]);
  const env = overrides.env ?? isolatedEnv();
  const session = createSession({
    container,
    images: container.images,
    port,
    storage,
    now: () => 1_000,
    approved: overrides.approved ?? approvedFor({ ...env, POOL_BUILD_DIGEST: container.images.pool }),
    readiness: overrides.readiness ?? { attempts: 3, wait: async () => {} },
    secretBindings: overrides.secretBindings ?? env,
    env,
    permit: overrides.permit,
  });
  return { session, container, storage, port };
}

test("routes every request to the code-enforced singleton", () => {
  const request = new Request("https://pool.example/v1/chat?instance=user-123");
  assert.equal(singletonName(request), SINGLETON_NAME);
  assert.equal(resolveSingletonId(singletonName(request)), SINGLETON_NAME);
  assert.throws(() => resolveSingletonId("user-123"), /rejects instance/);
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(index, /resolveSingletonId\(singletonName\(request\)\)/);
  assert.match(index, /getByName\(name\)/);
  assert.doesNotMatch(index, /idFromName\(request/);
  assert.match(index, /sessionFromContainer\(ctx, env\)/);
  assert.match(index, /approved: gate\.approved/);
});

test("start options use an approved digest and isolated bindings", () => {
  const options = startOptions({ pool: IMAGE }, isolatedEnv(), approvedFor());
  assert.equal(options.image, IMAGE);
  assert.equal(options.enableInternet, true);
  assert.deepEqual(options.instance, INSTANCE);
  assert.equal(options.instance.vcpu >= 0.0625, true);
  assert.equal(options.instance.memoryMib >= 256, true);
  assert.equal(options.instance.diskMb >= 2000, true);
  assert.equal(options.limits.mock, true);
  assert.equal(options.limits.notOnARealAccount, true);
  assert.equal(options.limits.notASixHourRun, true);
  assert.equal(options.limits.durableObjectBeta, true);
  assert.equal(options.limits.stopsOldProduction, false);
  assert.equal(options.env.SUB2API_RUNTIME, "cloudflare");
  assert.equal(options.env.SKIP_SETUP, "true");
  assert.equal(options.env.SUB2API_ISOLATION, "isolated");
  assert.equal(options.env.SUB2API_WRITER_PERMIT, "pool-writer-permit-fixture");
  assert.equal(Object.hasOwn(options.env, "AUTO_SETUP"), false);
  assert.equal(options.env.JWT_SECRET, "fixture-value");
  assert.throws(() => containerEnv({ ...isolatedEnv(), JWT_SECRET: "" }), /refusing empty secret binding/);
  assert.throws(() => containerEnv({ ...isolatedEnv(), SUB2API_WRITER_PERMIT: "production" }), /non-test/);
  assert.throws(() => startOptions({ pool: IMAGE }, isolatedEnv(), []), /not tied to a build source/);
  assert.throws(
    () => startOptions({ pool: `sha256:${"0".repeat(64)}` }, {}, [{
      role: "current",
      digest: `sha256:${"0".repeat(64)}`,
      sha: SHA,
    }]),
    /not tied to a build source/,
  );
});

test("scheduler.wait is the readiness retry", async () => {
  const waits = [];
  await schedulerWait(READINESS_WAIT_MS, {
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.deepEqual(waits, [READINESS_WAIT_MS]);
  await assert.rejects(() => schedulerWait(READINESS_WAIT_MS, {}), /scheduler\.wait is required/);
});

test("a closed port is retried until health returns 200", async () => {
  const waits = [];
  const port = healthPort(["ECONNREFUSED", "ECONNREFUSED", 200]);
  const { session, container } = sessionWith({
    port,
    readiness: {
      attempts: 3,
      waitMs: READINESS_WAIT_MS,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  });
  const response = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(response.status, 200);
  assert.equal(port.healthCalls, 3);
  assert.deepEqual(waits, [READINESS_WAIT_MS, READINESS_WAIT_MS]);
  assert.equal(session.state.ready, true);
  assert.equal(container.starts, 1);
});

test("start failure still arms the alarm and a later alarm can start", async () => {
  const container = fakeContainer();
  container.failStart = true;
  const { session, storage } = sessionWith({ container });
  await assert.rejects(() => session.alarm(), /start failed/);
  assert.equal(session.state.started, false);
  assert.equal(session.state.ready, false);
  assert.deepEqual(storage.alarms, [1_000 + WATCHDOG_INTERVAL_MS]);
  container.failStart = false;
  await session.alarm();
  assert.equal(container.running, true);
  assert.equal(container.starts, 1);
});

test("a non-zero exit does not stick in draining and can start again", async () => {
  const container = fakeContainer();
  const { session } = sessionWith({ container });
  await session.alarm();
  container.exitCode = 1;
  await session.noteExit();
  assert.equal(session.state.lifecycle, "stopped");
  assert.equal(session.state.started, false);
  assert.notEqual(session.state.lifecycle, "draining");
  container.exitCode = 0;
  container.running = false;
  session.state.started = true;
  await session.alarm();
  assert.equal(container.starts, 2);
  assert.equal(container.running, true);
});

test("a rebuilt durable object arms the alarm and restarts a stopped container", async () => {
  const storage = memoryStorage();
  const firstContainer = fakeContainer();
  const first = sessionWith({ storage, container: firstContainer });
  await first.session.alarm();
  assert.equal(firstContainer.running, true);

  const rebuilt = fakeContainer();
  const second = sessionWith({ storage, container: rebuilt });
  second.session.state.started = true;
  await second.session.onStart();
  assert.equal(second.session.state.started, false);
  assert.equal(second.session.state.ready, false);
  assert.equal(storage.alarms.length >= 1, true);
  assert.equal(rebuilt.running, false);
  await second.session.alarm();
  assert.equal(rebuilt.starts, 1);
  assert.equal(rebuilt.running, true);
});

test("zero traffic still arms the first alarm", async () => {
  const { session, storage, container } = sessionWith();
  await session.onStart();
  assert.equal(container.running, false);
  assert.equal(container.starts, 0);
  assert.deepEqual(storage.alarms, [1_000 + WATCHDOG_INTERVAL_MS]);
});

test("unreadiness does not proxy and the watchdog still reschedules", async () => {
  const waits = [];
  const port = healthPort([503]);
  const { session, storage, container } = sessionWith({
    port,
    readiness: {
      attempts: 2,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  });
  await assert.rejects(() => session.alarm(), /not ready/);
  assert.equal(session.state.ready, false);
  assert.equal(container.running, true);
  assert.deepEqual(waits, [READINESS_WAIT_MS]);
  assert.deepEqual(storage.alarms, [1_000 + WATCHDOG_INTERVAL_MS]);
});

test("streaming proxy returns the upstream body without reading it", async () => {
  let pulled = false;
  const stream = new ReadableStream({
    pull() {
      pulled = true;
      throw new Error("buffered");
    },
  });
  const proxied = proxyResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: stream,
  });
  assert.equal(proxied.body, stream);
  assert.equal(pulled, false);
});

test("SSE cancel follows the original request signal", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream();
  const port = healthPort([200], stream);
  const { session } = sessionWith({ port });
  const request = new Request("https://pool.example/v1/chat", {
    method: "POST",
    headers: { accept: "text/event-stream", "x-trace": "sse" },
    body: new ReadableStream(),
    duplex: "half",
    signal: controller.signal,
  });
  const pending = handleRequest(session.state, request);
  controller.abort();
  const response = await pending;
  assert.equal(response.body, stream);
  assert.equal(typeof response.text, "undefined");
  const forwarded = port.seen;
  assert.equal(forwarded instanceof Request, true);
  assert.equal(forwarded.body instanceof ReadableStream, true);
  assert.equal(new URL(forwarded.url).host, "container");
  assert.equal(forwarded.headers.get("x-trace"), "sse");
  assert.equal(forwarded.signal.aborted, true);
});

test("websocket upgrade is forwarded to the container host", () => {
  const request = new Request("https://pool.example/ws", {
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
  const forwarded = containerRequest(request);
  assert.equal(forwarded instanceof Request, true);
  assert.equal(forwarded.url, "http://container/ws");
  assert.equal(forwarded.headers.get("upgrade"), "websocket");
  assert.equal(forwarded.headers.get("host"), null);
});

test("watchdog restarts a crashed container even if started was left true", async () => {
  const { session, container } = sessionWith();
  await session.alarm();
  assert.equal(container.timeouts.at(-1), INACTIVITY_TIMEOUT_MS);
  await session.alarm();
  assert.equal(container.starts, 1);

  container.running = false;
  session.state.started = true;
  session.state.ready = true;
  await session.alarm();
  assert.equal(container.starts, 2);
  assert.equal(container.running, true);
});

test("SIGTERM drain handles a refused monitor and does not signal SIGKILL", async () => {
  const { session, container } = sessionWith();
  await session.alarm();
  session.state.lifecycle = "draining";
  const blocked = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(blocked.status, 503);
  session.state.lifecycle = "ready";
  container.exitCode = 1;
  await session.drain();
  assert.deepEqual(container.signals, [SIGTERM]);
  assert.equal(container.signals.includes(9), false);
  assert.equal(session.state.lifecycle, "stopped");
  assert.equal(container.running, false);
  container.exitCode = 0;
  const during = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(during.status, 200);
  assert.equal(container.starts, 2);
});

test("losing the isolated permit stops writers and drains before release", async () => {
  const { session } = sessionWith();
  assert.equal(session.state.permit.stopsOldProduction, false);
  const early = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(early.status, 200);
  await assert.rejects(() => session.releasePermit(), /background stop and drain/);
  assert.equal(session.state.permit.released, false);
  const refused = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(refused.status, 503);

  const order = [];
  await session.releasePermit(
    async () => {
      order.push("stop");
    },
    async () => {
      order.push("drain");
    },
  );
  assert.deepEqual(order, ["stop", "drain"]);
  assert.equal(session.state.permit.released, true);
  assert.equal(session.state.permit.stopsOldProduction, false);
  assert.throws(() => createSession({
    container: fakeContainer(),
    images: { pool: IMAGE },
    port: healthPort([200]),
    storage: memoryStorage(),
    env: { SUB2API_ISOLATION: "production", SUB2API_WRITER_PERMIT: "production" },
  }), /isolated bindings only/);
});

test("constructor refreshes the inactivity timeout and arms an alarm", async () => {
  const container = fakeContainer();
  container.start(startOptions(container.images, isolatedEnv(), approvedFor()));
  const { session, storage } = sessionWith({ container });
  await session.onStart();
  assert.equal(container.timeouts.at(-1), INACTIVITY_TIMEOUT_MS);
  assert.deepEqual(storage.alarms, [1_000 + WATCHDOG_INTERVAL_MS]);
  assert.equal(session.state.started, false);
});

test("two recorded digests are not a rollback", () => {
  const current = approvedFor()[0];
  const one = planRecovery([current]);
  assert.equal(one.executable, false);
  assert.equal(one.performsRollback, false);
  assert.equal(one.previousRecorded, false);
  assert.match(one.reason, /not available/);

  const two = planRecovery([
    current,
    { role: "previous", digest: PREVIOUS, sha: PREVIOUS_SHA, repo: REPO, runId: "43174764703" },
  ]);
  assert.equal(two.previousRecorded, true);
  assert.equal(two.executable, false);
  assert.equal(two.performsRollback, false);
  assert.equal(two.rollbackPerformed, false);
  assert.equal(two.digest, PREVIOUS);
  assert.equal(two.sha, PREVIOUS_SHA);
  assert.equal(two.notOnARealAccount, true);
  assert.equal(two.durableObjectBeta, true);
  assert.match(two.reason, /not a rollback/);
  assert.equal(LIMITS.rollbackPerformed, false);
});

test("formal openSession approval rejects a bare digest, hand-filled JSON, and any other database host", () => {
  const env = isolatedEnv();
  const gate = sessionFromContainer({ container: { images: { pool: IMAGE } } }, env);
  assert.equal(gate.approved[0].digest, IMAGE);
  assert.equal(gate.image, IMAGE);
  assert.throws(
    () => sessionFromContainer(
      { container: { images: { pool: `sha256:${"ab".repeat(32)}` } } },
      isolatedEnv({ POOL_BUILD_DIGEST: `sha256:${"ab".repeat(32)}` }),
    ),
    /bare sha256/,
  );
  assert.throws(
    () => sessionFromContainer(
      { container: { images: { pool: IMAGE } } },
      { ...env, POOL_BUILD_RECORD: JSON.stringify({ digest: IMAGE, sha: SHA, repo: REPO, runId: RUN_ID }) },
    ),
    /hand-filled JSON/,
  );
  assert.throws(
    () => sessionFromContainer(
      { container: { images: { pool: PREVIOUS } } },
      env,
    ),
    /does not equal ctx\.container\.images\.pool/,
  );
  for (const host of [
    "other-db.example",
    "ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.tech-isolated",
    "ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.techisolated",
    "ep-aged-sunset-b33os2qw-pooler.c-4.ap-southeast-1.aws.neon.tech-isolated",
  ]) {
    assert.throws(
      () => sessionFromContainer(
        { container: { images: { pool: IMAGE } } },
        isolatedEnv({ DATABASE_HOST: host }),
      ),
      /DATABASE_HOST/,
    );
  }
  const shared = sessionFromContainer(
    { container: { images: { pool: IMAGE } } },
    isolatedEnv({
      DATABASE_HOST: "ep-aged-sunset-b33os2qw-pooler.c-4.ap-southeast-1.aws.neon.tech",
      REDIS_HOST: "shared-upstash.example",
    }),
  );
  assert.equal(shared.permit.redisKeyPrefixApplied, false);
  const passed = containerEnv(isolatedEnv());
  assert.equal(passed.SUB2API_BACKGROUND_CONSUMERS, "off");
  assert.equal(passed.REDIS_KEY_PREFIX, "staging:");
  assert.equal(passed.POOL_ISOLATED_REDIS_HOSTS, undefined);
  assert.equal(passed.CONFIG_FILE, "/app/data/config.yaml");
  assert.equal(passed.DATA_DIR, "/app/data");
  assert.equal(passed.STAGING_TEST_JWT_SECRET, "staging-test-jwt-secret-not-production");
  assert.throws(
    () => sessionFromContainer(
      { container: { images: { pool: IMAGE } } },
      isolatedEnv({ SUB2API_BACKGROUND_CONSUMERS: "on" }),
    ),
    /background consumers/,
  );
});

test("candidate check ties the digest to its build source and does not deploy", () => {
  const sha = "35e730955c955a4901619fa9a92c68904afcb934";
  const digest = `registry.cloudflare.com/example-account/needtoken-pool@sha256:${"cd".repeat(32)}`;
  const bound = bindCandidate({
    mainSha: sha,
    digest,
    originMainSha: sha,
    buildSourceSha: sha,
    headSha: sha,
    runId: RUN_ID,
  });
  assert.equal(bound.deployed, false);
  assert.equal(bound.rollback, false);
  assert.equal(bound.authorizesBoot, false);
  assert.equal(bound.pgDump, "unverified");
  assert.equal(bound.buildSourceSha, sha);
  assert.throws(
    () => bindCandidate({
      mainSha: sha,
      digest,
      originMainSha: sha,
      buildSourceSha: "c".repeat(40),
      headSha: sha,
      runId: RUN_ID,
    }),
    /build source/,
  );
  assert.throws(
    () => bindCandidate({
      mainSha: sha,
      digest: `sha256:${"0".repeat(64)}`,
      originMainSha: sha,
      buildSourceSha: sha,
      headSha: sha,
      runId: RUN_ID,
    }),
    /fail-closed/,
  );
  assert.throws(
    () => bindCandidate({ mainSha: sha, digest, originMainSha: sha, buildSourceSha: sha, headSha: sha }),
    /run id/,
  );
  const result = selfTest();
  assert.equal(result.deployed, false);
  assert.equal(result.rollback, false);
  assert.equal(result.pgDump, "unverified");

  const recorded = { recorded: true, repository: REPO, sha, run_id: RUN_ID, digest };
  assert.doesNotThrow(() => assertStagingImageConfig({
    containers: [{ images: { pool: { image: digest } } }],
  }, recorded));
  assert.throws(() => assertStagingImageConfig({
    containers: [{ images: { pool: { dockerfile: "../Dockerfile", build_context: ".." } } }],
  }, recorded), /rebuild/);
  assert.throws(() => assertStagingImageConfig({
    containers: [{ images: { pool: { image: digest } } }],
  }, { recorded: false, digest: "" }), /digest recorded by CI/);
});
