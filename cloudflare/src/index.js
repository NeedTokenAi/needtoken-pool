import { DurableObject } from "cloudflare:workers";
import { containerEnv } from "./env.js";
import {
  READY_INTERVAL_MS,
  READY_WAIT_MS,
  notReadyResponse,
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

async function healthReady(container) {
  const response = await container.getTcpPort(APP_PORT).fetch("http://container/health");
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

  async ensureStarted() {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        env: containerEnv(this.env),
        enableInternet: true,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return container;
  }

  async fetch(request) {
    try {
      const container = await this.ensureStarted();
      if (!this.healthy) {
        if (!(await healthReady(container))) return notReadyResponse();
        this.healthy = true;
      }
      return await container.getTcpPort(APP_PORT).fetch(forwardedRequest(request));
    } catch (error) {
      this.healthy = false;
      console.error("container is not ready", error);
      return notReadyResponse();
    }
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
