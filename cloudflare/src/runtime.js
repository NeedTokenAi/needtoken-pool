export const SINGLETON_NAME = "needtoken-pool";
export const CONTAINER_PORT = 8080;
export const INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 60 * 1000;
export const READINESS_ATTEMPTS = 20;
export const READINESS_WAIT_MS = 200;
export const SIGTERM = 15;

// Local mock labels. These values were not measured on a Cloudflare account,
// the six-hour inactivity limit was not run, and durable_object is public beta.
export const LIMITS = {
  mock: true,
  notOnARealAccount: true,
  notASixHourRun: true,
  durableObjectBeta: true,
  stopsOldProduction: false,
  rollbackPerformed: false,
};

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

const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

export function mandatoryContainerEnv() {
  return {
    SUB2API_RUNTIME: "cloudflare",
    SKIP_SETUP: "true",
    SUB2API_ISOLATION: "isolated",
    SUB2API_WRITER_PERMIT: "isolated",
  };
}

export function containerEnv(bindings = {}) {
  if (bindings.SUB2API_ISOLATION && bindings.SUB2API_ISOLATION !== "isolated") {
    throw new Error("candidate allows isolated bindings only");
  }
  if (bindings.SUB2API_WRITER_PERMIT && bindings.SUB2API_WRITER_PERMIT !== "isolated") {
    throw new Error("candidate allows isolated bindings only");
  }
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

export function isolatedPermit(env = {}) {
  const isolation = env.SUB2API_ISOLATION ?? "isolated";
  const permit = env.SUB2API_WRITER_PERMIT ?? "isolated";
  if (isolation !== "isolated" || permit !== "isolated") {
    throw new Error("candidate allows isolated bindings only");
  }
  return {
    isolated: true,
    held: true,
    lost: false,
    released: false,
    stopsOldProduction: false,
  };
}

function approvedSlot(image, approved) {
  return (approved ?? []).find((slot) => {
    return slot?.digest === image
      && slot.digest !== PLACEHOLDER_DIGEST
      && /^sha256:[0-9a-f]{64}$/.test(slot.digest ?? "")
      && /^[0-9a-f]{40}$/.test(slot.sha ?? "");
  });
}

export function startOptions(images, bindings, approved) {
  const image = images?.pool;
  if (!image || !approvedSlot(image, approved)) {
    throw new Error("image is not tied to a build source");
  }
  return {
    image,
    enableInternet: true,
    instance: INSTANCE,
    env: containerEnv(bindings),
    limits: LIMITS,
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

// scheduler.wait is the Workers scheduler global. Deployed timers do not
// advance during CPU-only execution; this wait runs between failed port fetches.
export async function schedulerWait(milliseconds, schedulerImpl = globalThis.scheduler) {
  if (!schedulerImpl || typeof schedulerImpl.wait !== "function") {
    throw new Error("scheduler.wait is required");
  }
  await schedulerImpl.wait(milliseconds);
}

export async function waitUntilReady(fetchHealth, options = {}) {
  const attempts = options.attempts ?? READINESS_ATTEMPTS;
  const wait = options.wait ?? ((milliseconds) => schedulerWait(milliseconds, options.scheduler));
  const waitMs = options.waitMs ?? READINESS_WAIT_MS;
  let lastError = new Error("container not ready");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchHealth();
      if (response?.body && typeof response.body.cancel === "function") {
        await response.body.cancel();
      }
      if (response?.ok || response?.status === 200) {
        return;
      }
      lastError = new Error(`container not ready: ${response?.status ?? 0}`);
    } catch (error) {
      lastError = new Error(`container not ready: ${error?.message ?? "closed port"}`);
    }
    if (attempt + 1 < attempts) {
      await wait(waitMs);
    }
  }
  throw lastError;
}

export function containerRequest(request) {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  return forwarded;
}

export function proxyResponse(upstream) {
  return upstream;
}

function markStopped(state) {
  state.ready = false;
  state.started = false;
  state.lifecycle = "stopped";
  try {
    state.container.running = false;
  } catch {
    // The platform owns Container.running.
  }
}

export async function noteExit(state) {
  try {
    await state.container.monitor();
  } catch {
    // monitor() rejects with Error.exitCode when the container exits non-zero.
  } finally {
    markStopped(state);
  }
}

export async function ensureStarted(state) {
  if (state.lifecycle === "draining") {
    throw new Error("container is draining");
  }
  if (!state.container.running) {
    state.started = false;
    state.ready = false;
    state.lifecycle = "starting";
    try {
      state.container.start(startOptions(state.images, state.secretBindings, state.approved));
    } catch (error) {
      markStopped(state);
      throw error;
    }
    state.started = true;
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
  if (!state.ready) {
    try {
      await waitUntilReady(
        () => state.port.fetch("http://container/health", {
          signal: AbortSignal.timeout(1000),
        }),
        state.readiness,
      );
    } catch (error) {
      state.ready = false;
      state.lifecycle = "stopped";
      throw error;
    }
    state.ready = true;
    state.lifecycle = "ready";
  } else {
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
}

export async function handleRequest(state, request) {
  if (!state.permit?.held || state.permit.lost || state.permit.released || !state.permit.isolated) {
    return new Response("isolated writer permit is not held", { status: 503 });
  }
  if (state.lifecycle === "draining") {
    return new Response("draining", { status: 503 });
  }
  await ensureStarted(state);
  return proxyResponse(await state.port.fetch(containerRequest(request)));
}

export async function drain(state) {
  state.lifecycle = "draining";
  state.ready = false;
  try {
    if (state.container.running) {
      state.container.signal(SIGTERM);
    }
    await state.container.monitor();
  } catch {
    // A refused monitor still finishes the drain so a later start can run.
  } finally {
    markStopped(state);
  }
}

// HTTP 503 is not the release. Background writes stop and the process drains first.
export async function releasePermit(state, stopBackground, drainProcess) {
  if (!state.permit?.isolated || state.permit.stopsOldProduction) {
    throw new Error("candidate allows isolated bindings only");
  }
  state.permit.lost = true;
  if (typeof stopBackground !== "function" || typeof drainProcess !== "function") {
    throw new Error("permit release requires background stop and drain");
  }
  await stopBackground();
  await drainProcess();
  state.permit.held = false;
  state.permit.released = true;
}

export async function runWatchdog(state) {
  try {
    await ensureStarted(state);
  } finally {
    await state.storage.setAlarm(state.now() + WATCHDOG_INTERVAL_MS);
  }
}

export async function onDurableObjectStart(state) {
  state.ready = false;
  state.started = false;
  if (state.container?.running) {
    await state.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }
  await state.storage.setAlarm(state.now() + WATCHDOG_INTERVAL_MS);
}

export function recoveryState(slots) {
  const approved = (slots ?? []).filter((slot) => approvedSlot(slot?.digest, [slot]));
  const digests = new Set(approved.map((slot) => slot.digest));
  return {
    phase: "stopped",
    slots: approved,
    previousRecorded: digests.size >= 2,
    executable: false,
    rollbackPerformed: false,
    mock: true,
    notOnARealAccount: true,
    notASixHourRun: true,
    durableObjectBeta: true,
  };
}

export function planRecovery(slots) {
  const state = recoveryState(slots);
  const previous = state.slots.find((slot) => slot.role === "previous");
  if (!state.previousRecorded || !previous) {
    return {
      ...state,
      performsRollback: false,
      reason: "rollback is not available",
    };
  }
  return {
    ...state,
    performsRollback: false,
    digest: previous.digest,
    sha: previous.sha,
    reason: "two approved digests are recorded; switching them is not a rollback",
  };
}

export function createSession(deps) {
  const state = {
    container: deps.container,
    images: deps.images,
    port: deps.port,
    secretBindings: deps.secretBindings ?? {},
    approved: deps.approved ?? [],
    storage: deps.storage,
    now: deps.now ?? (() => Date.now()),
    readiness: deps.readiness ?? { attempts: READINESS_ATTEMPTS, waitMs: READINESS_WAIT_MS },
    permit: deps.permit ?? isolatedPermit(deps.env),
    lifecycle: "stopped",
    ready: false,
    started: false,
  };
  return {
    state,
    onStart: () => onDurableObjectStart(state),
    alarm: () => runWatchdog(state),
    fetch: (request) => handleRequest(state, request),
    drain: () => drain(state),
    noteExit: () => noteExit(state),
    releasePermit: (stopBackground, drainProcess) => releasePermit(state, stopBackground, drainProcess),
  };
}
