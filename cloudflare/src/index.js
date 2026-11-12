import { DurableObject } from "cloudflare:workers";
import { containerEnv } from "./env.js";
import {
  HEALTH_PROBE_MS,
  READY_INTERVAL_MS,
  READY_WAIT_MS,
  dispatchReady,
  notReadyResponse,
  probeHealth,
  waitForReady,
} from "./ready.js";

const APP_PORT = 8080;
// setInactivityTimeout rejects 0 and any value above 6 hours, so 24h is illegal.
// The minute cron addresses this Durable Object, which keeps the container resident.
const INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RESIDENT_INSTANCE = "instance-0";

export function forwardedRequest(request) {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  return forwarded;
}

function resident(env) {
  return env.POOL.getByName(RESIDENT_INSTANCE);
}

async function healthReady(container, signal) {
  const response = await container.getTcpPort(APP_PORT).fetch("http://container/health", {
    signal,
  });
  const ready = response.ok;
  await response.body?.cancel();
  return ready;
}

export class PoolContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.healthy = false;
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async fetch(request) {
    const container = this.ctx.container;
    try {
      if (!container.running) {
        this.healthy = false;
        container.start({
          env: containerEnv(this.env),
          enableInternet: true,
        });
      }
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      this.healthy = false;
      console.error("container did not start", error);
      return notReadyResponse();
    }

    // 503 is only for this probe. The client request is forwarded after it.
    return dispatchReady(
      async () => {
        if (this.healthy) return true;
        const ready = await probeHealth(
          (signal) => healthReady(container, signal),
          HEALTH_PROBE_MS,
        );
        if (ready) this.healthy = true;
        return ready;
      },
      () => container.getTcpPort(APP_PORT).fetch(forwardedRequest(request)),
    );
  }
}

export default {
  async fetch(request, env) {
    return resident(env).fetch(request);
  },

  async scheduled(_controller, env) {
    const ready = await waitForReady(
      async () => {
        const response = await resident(env).fetch("http://needtoken-pool/health");
        if (response.ok) return response;
        await response.body?.cancel();
        return false;
      },
      (ms) => scheduler.wait(ms),
      READY_WAIT_MS,
      READY_INTERVAL_MS,
    );
    return ready ?? notReadyResponse();
  },
};
