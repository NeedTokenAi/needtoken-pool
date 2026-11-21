import { isEdgeOnlyEnvKey } from "./admin_gate.js";

// Copy Worker vars and wrangler secrets through as container environment.
// Non-string bindings, such as the Durable Object namespace, are not env vars.
export function containerEnv(env) {
  const passed = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string" && !isEdgeOnlyEnvKey(key)) {
      passed[key] = value;
    }
  }
  return passed;
}
