export const SINGLETON_NAME = "needtoken-pool";
export const CONTAINER_PORT = 8080;
export const INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 60 * 1000;
export const SIGTERM = 15;

// Placeholder size that meets the durable_object custom minimums
// (vcpu >= 1/16, memory >= 256 MiB, disk >= 2000 MB) and stays under the
// default account maximums. It is not a measured production size.
export const INSTANCE = { vcpu: 1, memoryMib: 2048, diskMb: 4000 };

export const SECRET_BINDING_NAMES = [
  "JWT_SECRET",
  "TOTP_ENCRYPTION_KEY",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
  "DATABASE_DBNAME",
  "DATABASE_SSLMODE",
  "REDIS_HOST",
  "REDIS_PORT",
  "REDIS_USERNAME",
  "REDIS_PASSWORD",
  "REDIS_DB",
  "REDIS_ENABLE_TLS",
];

export function mandatoryContainerEnv() {
  return {
    SUB2API_RUNTIME: "cloudflare",
    SKIP_SETUP: "true",
  };
}

export function containerEnv(bindings = {}) {
  const env = mandatoryContainerEnv();
  for (const name of SECRET_BINDING_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(bindings, name)) {
      continue;
    }
    const value = bindings[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`refusing empty secret binding ${name}`);
    }
    env[name] = value;
  }
  if (Object.prototype.hasOwnProperty.call(env, "AUTO_SETUP")) {
    throw new Error("AUTO_SETUP must stay off");
  }
  return env;
}

export function startOptions(images, bindings) {
  const image = images?.pool;
  if (!image) {
    throw new Error("missing pool image reference");
  }
  return {
    image,
    enableInternet: true,
    instance: INSTANCE,
    env: containerEnv(bindings),
  };
}

export function singletonName(_request) {
  return SINGLETON_NAME;
}

export function resolveSingletonId(requested) {
  if (requested !== SINGLETON_NAME) {
    throw new Error(`pool singleton rejects instance ${requested}`);
  }
  return SINGLETON_NAME;
}

export function initialFence() {
  return { epoch: 0, status: "idle" };
}

export function acquireWriter(fence) {
  if (fence.status === "active" || fence.status === "draining") {
    throw new Error("fenced: writer already held");
  }
  return { epoch: fence.epoch + 1, status: "active" };
}

export function assertWriter(fence, epoch) {
  if (fence.status !== "active" || fence.epoch !== epoch) {
    throw new Error("fenced");
  }
}

export function beginDrain(fence, epoch) {
  assertWriter(fence, epoch);
  return { epoch, status: "draining" };
}

export function finishDrain(fence, epoch) {
  if (fence.status !== "draining" || fence.epoch !== epoch) {
    throw new Error("fenced");
  }
  return { epoch, status: "idle" };
}

export function recoverDeadWriter(fence) {
  if (fence.status === "draining") {
    throw new Error("fenced: drain in progress");
  }
  if (fence.status !== "active") {
    throw new Error("fenced: writer is not active");
  }
  return { epoch: fence.epoch + 1, status: "active" };
}

export async function waitUntilReady(fetchHealth, options = {}) {
  const attempts = options.attempts ?? 5;
  const sleep = options.sleep ?? (async () => {});
  let last = 0;
  for (let i = 0; i < attempts; i += 1) {
    const response = await fetchHealth();
    last = response?.status ?? 0;
    if (last === 200) {
      return;
    }
    if (i + 1 < attempts) {
      await sleep();
    }
  }
  throw new Error(`container not ready: ${last}`);
}

export function proxyResponse(upstream) {
  return {
    status: upstream.status,
    headers: upstream.headers,
    body: upstream.body,
  };
}

async function persistFence(state) {
  await state.storage.put("fence", state.fence);
}

export async function ensureStarted(state) {
  if (state.fence.status === "draining") {
    throw new Error("fenced: drain in progress");
  }
  if (!state.container.running) {
    state.fence = state.fence.status === "active"
      ? recoverDeadWriter(state.fence)
      : acquireWriter(state.fence);
    state.ready = false;
    await persistFence(state);
    state.container.start(startOptions(state.images, state.secretBindings));
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  } else if (state.fence.status !== "active") {
    state.fence = acquireWriter(state.fence);
    await persistFence(state);
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
  if (!state.ready) {
    await waitUntilReady(
      () => state.port.fetch("http://container/health"),
      state.readiness,
    );
    state.ready = true;
  } else {
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
  state.epoch = state.fence.epoch;
  return state.fence;
}

export async function handleRequest(state, request) {
  if (state.fence.status === "draining") {
    return new Response("draining", { status: 503 });
  }
  await ensureStarted(state);
  assertWriter(state.fence, state.epoch);
  const url = new URL(request.url);
  const init = {
    method: request.method,
    headers: request.headers,
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  const upstream = await state.port.fetch(
    `http://container${url.pathname}${url.search}`,
    init,
  );
  const proxied = proxyResponse(upstream);
  return new Response(proxied.body, {
    status: proxied.status,
    headers: proxied.headers,
  });
}

export async function drain(state) {
  if (state.fence.status !== "active") {
    throw new Error("no active writer to drain");
  }
  const epoch = state.fence.epoch;
  state.fence = beginDrain(state.fence, epoch);
  state.ready = false;
  await persistFence(state);
  state.container.signal(SIGTERM);
  await state.container.monitor();
  state.fence = finishDrain(state.fence, epoch);
  await persistFence(state);
}

export async function runWatchdog(state) {
  try {
    await ensureStarted(state);
  } finally {
    await state.storage.setAlarm(state.now() + WATCHDOG_INTERVAL_MS);
  }
}

export async function onDurableObjectStart(state) {
  if (state.container?.running) {
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
}

export function createSession(deps) {
  const state = {
    container: deps.container,
    images: deps.images,
    port: deps.port,
    secretBindings: deps.secretBindings ?? {},
    storage: deps.storage,
    now: deps.now ?? (() => Date.now()),
    readiness: deps.readiness ?? { attempts: 5, sleep: async () => {} },
    fence: deps.fence ?? initialFence(),
    ready: false,
    epoch: deps.fence?.epoch ?? 0,
  };
  return {
    state,
    onStart: () => onDurableObjectStart(state),
    alarm: () => runWatchdog(state),
    fetch: (request) => handleRequest(state, request),
    drain: () => drain(state),
  };
}
