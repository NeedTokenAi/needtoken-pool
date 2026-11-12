import { DurableObject } from "cloudflare:workers";
import { containerEnv } from "./env.js";

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

export class PoolContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async fetch(request) {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        env: containerEnv(this.env),
        enableInternet: true,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return container.getTcpPort(APP_PORT).fetch(forwardedRequest(request));
  }
}

export default {
  async fetch(request, env) {
    return resident(env).fetch(request);
  },

  async scheduled(_controller, env) {
    return resident(env).fetch("http://needtoken-pool/health");
  },
};
