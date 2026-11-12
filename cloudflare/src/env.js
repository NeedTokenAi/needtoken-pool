// Copy Worker vars and wrangler secrets through as container environment.
// Non-string bindings, such as the Durable Object namespace, are not env vars.
export function containerEnv(env) {
  const passed = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      passed[key] = value;
    }
  }
  return passed;
}
