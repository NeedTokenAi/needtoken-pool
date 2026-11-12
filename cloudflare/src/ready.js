export const READY_WAIT_MS = 210_000;
export const READY_INTERVAL_MS = 1_000;
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
