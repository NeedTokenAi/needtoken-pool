import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bindCandidate, selfTest } from "../candidate-check.mjs";
import {
  INACTIVITY_TIMEOUT_MS,
  INSTANCE,
  SIGTERM,
  SINGLETON_NAME,
  WATCHDOG_INTERVAL_MS,
  acquireWriter,
  assertWriter,
  containerEnv,
  createSession,
  handleRequest,
  initialFence,
  proxyResponse,
  recoverDeadWriter,
  resolveSingletonId,
  singletonName,
  startOptions,
} from "./runtime.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;

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
  const timeouts = [];
  return {
    signals,
    timeouts,
    images: { pool: DIGEST },
    get running() {
      return running;
    },
    set running(value) {
      running = value;
    },
    start(options) {
      if (running) {
        throw new Error("already running");
      }
      started = options;
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
      running = false;
    },
  };
}

function healthPort(statuses, stream) {
  let healthCalls = 0;
  return {
    get healthCalls() {
      return healthCalls;
    },
    async fetch(url, init) {
      if (String(url).endsWith("/health")) {
        const status = statuses[Math.min(healthCalls, statuses.length - 1)];
        healthCalls += 1;
        return { status };
      }
      return {
        status: 200,
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
  const session = createSession({
    container,
    images: container.images,
    port,
    storage,
    now: () => 1_000,
    readiness: overrides.readiness ?? { attempts: 3, sleep: async () => {} },
    fence: overrides.fence,
    secretBindings: overrides.secretBindings,
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
  assert.match(index, /idFromName\(name\)/);
  assert.doesNotMatch(index, /idFromName\(request/);
});

test("start options use the digest, internet, and no generated secrets", () => {
  const options = startOptions({ pool: DIGEST }, { JWT_SECRET: "fixture-value" });
  assert.equal(options.image, DIGEST);
  assert.equal(options.enableInternet, true);
  assert.deepEqual(options.instance, INSTANCE);
  assert.equal(options.instance.vcpu >= 0.0625, true);
  assert.equal(options.instance.memoryMib >= 256, true);
  assert.equal(options.instance.diskMb >= 2000, true);
  assert.equal(options.env.SUB2API_RUNTIME, "cloudflare");
  assert.equal(options.env.SKIP_SETUP, "true");
  assert.equal(Object.hasOwn(options.env, "AUTO_SETUP"), false);
  assert.equal(options.env.JWT_SECRET, "fixture-value");
  assert.throws(() => containerEnv({ JWT_SECRET: "" }), /refusing empty secret binding/);
});

test("readiness blocks traffic until health returns 200", async () => {
  const port = healthPort([503, 503, 200]);
  const { session } = sessionWith({
    port,
    readiness: { attempts: 3, sleep: async () => {} },
  });
  const response = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(response.status, 200);
  assert.equal(port.healthCalls, 3);
  assert.equal(session.state.ready, true);
  assert.equal(session.state.container.started().image, DIGEST);
});

test("unreadiness does not proxy and the watchdog still reschedules", async () => {
  const port = healthPort([503]);
  const { session, storage, container } = sessionWith({
    port,
    readiness: { attempts: 2, sleep: async () => {} },
  });
  await assert.rejects(() => session.alarm(), /not ready/);
  assert.equal(session.state.ready, false);
  assert.equal(container.running, true);
  assert.deepEqual(storage.alarms, [1_000 + WATCHDOG_INTERVAL_MS]);
  const again = healthPort([503]);
  session.state.port = again;
  await assert.rejects(() => session.alarm(), /not ready/);
  assert.equal(container.started() !== null, true);
  assert.equal(again.healthCalls, 2);
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

test("request body is forwarded as the same stream", async () => {
  const requestBody = new ReadableStream();
  let seen;
  const port = {
    async fetch(url, init) {
      if (String(url).endsWith("/health")) {
        return { status: 200 };
      }
      seen = init;
      return { status: 200, headers: {}, body: null };
    },
  };
  const { session } = sessionWith({ port });
  await handleRequest(session.state, {
    url: "https://pool.example/v1/chat",
    method: "POST",
    headers: new Headers(),
    body: requestBody,
  });
  assert.equal(seen.body, requestBody);
  assert.equal(seen.duplex, "half");
});

test("watchdog recovers a dead writer and refreshes a live one", async () => {
  const { session, container } = sessionWith();
  await session.alarm();
  const first = session.state.fence.epoch;
  assert.equal(container.timeouts.at(-1), INACTIVITY_TIMEOUT_MS);
  await session.alarm();
  assert.equal(session.state.fence.epoch, first);

  container.running = false;
  await session.alarm();
  assert.equal(session.state.fence.epoch, first + 1);
  assert.equal(container.running, true);
  assert.throws(() => assertWriter(session.state.fence, first), /fenced/);
});

test("SIGTERM drain fences the old writer and does not signal SIGKILL", async () => {
  const { session, container } = sessionWith();
  await session.alarm();
  const epoch = session.state.fence.epoch;
  session.state.fence = { epoch, status: "draining" };
  const blocked = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.equal(blocked.status, 503);
  session.state.fence = { epoch, status: "active" };
  await session.drain();
  assert.deepEqual(container.signals, [SIGTERM]);
  assert.equal(container.signals.includes(9), false);
  assert.equal(session.state.fence.status, "idle");
  assert.equal(container.running, false);
  const during = await session.fetch(new Request("https://pool.example/v1/chat"));
  assert.notEqual(during.status, undefined);
  await session.alarm();
  assert.equal(session.state.fence.epoch, epoch + 1);
  assert.throws(() => assertWriter(session.state.fence, epoch), /fenced/);
});

test("a second writer cannot acquire the active fence", () => {
  const active = acquireWriter(initialFence());
  assert.throws(() => acquireWriter(active), /already held/);
  assert.throws(() => recoverDeadWriter({ epoch: 1, status: "draining" }), /drain in progress/);
});

test("constructor refreshes the inactivity timeout when the container is already running", async () => {
  const container = fakeContainer();
  container.start(startOptions(container.images, {}));
  const { session } = sessionWith({ container, fence: { epoch: 4, status: "active" } });
  await session.onStart();
  assert.equal(container.timeouts.at(-1), INACTIVITY_TIMEOUT_MS);
});

test("candidate check binds main SHA and digest without deploying", () => {
  const sha = "35e730955c955a4901619fa9a92c68904afcb934";
  const digest = `sha256:${"cd".repeat(32)}`;
  const bound = bindCandidate({ mainSha: sha, digest, originMainSha: sha });
  assert.equal(bound.deployed, false);
  assert.equal(bound.pgDump, "unverified");
  assert.equal(bound.mainSha, sha);
  assert.throws(
    () => bindCandidate({ mainSha: sha, digest, originMainSha: "a".repeat(40) }),
    /not origin\/main/,
  );
  assert.throws(() => bindCandidate({ mainSha: "abc", digest, originMainSha: "abc" }), /40 hex/);
  const result = selfTest();
  assert.equal(result.deployed, false);
  assert.equal(result.pgDump, "unverified");
});
