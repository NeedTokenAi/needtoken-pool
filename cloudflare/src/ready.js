export const READY_WAIT_MS = 210_000;
export const READY_INTERVAL_MS = 1_000;
export const HEALTH_PROBE_MS = 5_000;
export const RETRY_AFTER_SECONDS = 15;

export function notReadyResponse() {
  return new Response("container is starting", {
    status: 503,
    headers: {
      "retry-after": String(RETRY_AFTER_SECONDS),
      "cache-control": "no-store",
    },
  });
}

// probe returns a truthy result when the port is ready. A closed port throws.
// The wait stays outside the Durable Object so a long cron retry does not block
// other requests to the same instance.
export async function waitForReady(probe, wait, deadlineMs, intervalMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const result = await probe();
      if (result) return result;
    } catch {
      // The port is not accepting connections yet.
    }
    if (Date.now() + intervalMs > deadline) return null;
    await wait(intervalMs);
  }
}

// fetchHealth receives an abort signal. A timeout, a closed port, or a
// non-ok probe means the client request has not been sent yet.
export async function probeHealth(fetchHealth, timeoutMs = HEALTH_PROBE_MS) {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    return Boolean(await fetchHealth(signal));
  } catch {
    return false;
  }
}

// forward() is the client request. Its result or error is not replaced with 503.
export async function dispatchReady(ready, forward) {
  if (!(await ready())) return notReadyResponse();
  return forward();
}
