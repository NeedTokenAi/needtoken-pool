import { DurableObject } from "cloudflare:workers";
import {
  CONTAINER_PORT,
  createSession,
  resolveSingletonId,
  singletonName,
} from "./runtime.js";

async function openSession(ctx, env) {
  const container = ctx.container;
  const stored = await ctx.storage.get("fence");
  const session = createSession({
    container,
    images: container.images,
    port: container.getTcpPort(CONTAINER_PORT),
    secretBindings: env,
    fence: stored ?? undefined,
    storage: {
      put: (key, value) => ctx.storage.put(key, value),
      setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
    },
  });
  await session.onStart();
  return session;
}

export class PoolContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.session = await openSession(ctx, env);
    });
  }

  async fetch(request) {
    await this.ready;
    return this.session.fetch(request);
  }

  async alarm() {
    await this.ready;
    await this.session.alarm();
  }

  async drain() {
    await this.ready;
    await this.session.drain();
  }
}

export default {
  async fetch(request, env) {
    const name = resolveSingletonId(singletonName(request));
    return env.POOL.getByName(name).fetch(request);
  },
};
