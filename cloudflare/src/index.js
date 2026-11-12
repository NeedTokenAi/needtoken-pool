import { DurableObject } from "cloudflare:workers";
import { containerEnv } from "./env.js";

const APP_PORT = 8080;

export function forwardedRequest(request) {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  return forwarded;
}

export class PoolContainer extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        env: containerEnv(this.env),
        enableInternet: true,
      });
    }
    return container.getTcpPort(APP_PORT).fetch(forwardedRequest(request));
  }
}

export default {
  async fetch(request, env) {
    return env.POOL.getByName("needtoken-pool").fetch(request);
  },
};
