import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_ENTRY_PATH,
  EDGE_ADMIN_COOKIE,
  EDGE_ADMIN_HEADER,
  handleEdgeAdminGate,
  stripEdgeGateHeaders,
} from "./admin_gate.js";
import { containerEnv } from "./env.js";

const TEST_SECRET = "p".repeat(48);

function createMockSql() {
  const tickets = new Map();
  const sessions = new Map();
  return {
    tickets,
    sessions,
    exec(query, ...params) {
      const q = query.replace(/\s+/g, " ").trim();
      if (q.startsWith("CREATE TABLE IF NOT EXISTS")) return { toArray: () => [] };
      if (q.startsWith("DELETE FROM nt_edge_admin_tickets WHERE expires_at <= ?")) {
        for (const [k, v] of tickets) if (v.expires_at <= params[0]) tickets.delete(k);
        return { toArray: () => [] };
      }
      if (q.startsWith("DELETE FROM nt_edge_admin_sessions WHERE expires_at <= ?")) {
        for (const [k, v] of sessions) if (v.expires_at <= params[0]) sessions.delete(k);
        return { toArray: () => [] };
      }
      if (q.startsWith("SELECT session_id, actor, reason, created_at, expires_at FROM nt_edge_admin_sessions")) {
        return { toArray: () => [...sessions.values()].filter((r) => r.expires_at > params[0]).sort((a, b) => b.created_at - a.created_at) };
      }
      if (q.startsWith("SELECT COUNT(*) AS cnt FROM nt_edge_admin_tickets")) {
        return { toArray: () => [{ cnt: [...tickets.values()].filter((r) => r.expires_at > params[0]).length }] };
      }
      if (q.startsWith("SELECT session_id FROM nt_edge_admin_sessions WHERE session_id = ?")) {
        const row = sessions.get(params[0]);
        return { toArray: () => (row && row.expires_at > params[1] ? [{ session_id: params[0] }] : []) };
      }
      if (q.startsWith("INSERT INTO nt_edge_admin_tickets")) {
        const [token_hash, actor, reason, ttl_seconds, created_at, expires_at] = params;
        tickets.set(token_hash, { token_hash, actor, reason, ttl_seconds, created_at, expires_at });
        return { toArray: () => [] };
      }
      if (q.startsWith("SELECT token_hash, actor, reason, ttl_seconds, expires_at FROM nt_edge_admin_tickets")) {
        const row = tickets.get(params[0]);
        return { toArray: () => (row && row.expires_at > params[1] ? [row] : []) };
      }
      if (q.startsWith("DELETE FROM nt_edge_admin_tickets WHERE token_hash = ?")) {
        tickets.delete(params[0]);
        return { toArray: () => [] };
      }
      if (q.startsWith("INSERT INTO nt_edge_admin_sessions")) {
        const [session_id, actor, reason, created_at, expires_at] = params;
        sessions.set(session_id, { session_id, actor, reason, created_at, expires_at });
        return { toArray: () => [] };
      }
      if (q === "DELETE FROM nt_edge_admin_sessions") {
        sessions.clear();
        return { toArray: () => [] };
      }
      if (q === "DELETE FROM nt_edge_admin_tickets") {
        tickets.clear();
        return { toArray: () => [] };
      }
      throw new Error(`unexpected SQL: ${q}`);
    },
  };
}

test("pool default-deny allows only inference gateway and health publicly while returning 404 for SPA and non-gateway APIs", async () => {
  const sql = createMockSql();
  const env = { EDGE_ADMIN_SECRET: TEST_SECRET };

  for (const openPath of [
    "/health",
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "/v1beta/models",
    "/backend-api/codex/responses",
    "/antigravity/v1/messages",
    "/api/event_logging/batch",
  ]) {
    const res = await handleEdgeAdminGate(new Request(`https://pool.example${openPath}`), env, sql);
    assert.equal(res.allow, true, `expected allow for ${openPath}`);
  }

  for (const blockedPath of [
    "/",
    "/login",
    "/admin",
    "/admin/accounts",
    "/assets/index.js",
    "/setup/status",
    "/api/v1/auth/login",
    "/api/v1/user/profile",
    "/api/v1/payment/orders",
    "/api/v1/model-plaza",
    "/api/v1/admin/settings",
    "/api/v1/admin/ops/account-availability",
    "/api/v1/admin/accounts",
    "/api/v1/admin/groups",
    "/api/v1/admin/proxies",
    "/v1/../admin",
    "//admin",
  ]) {
    const res = await handleEdgeAdminGate(new Request(`https://pool.example${blockedPath}`), env, sql);
    assert.equal(res.response?.status, 404, `expected 404 for ${blockedPath}`);
  }
});

test("internal secret unlocks only glue/ops pool admin APIs while break-glass cookie unlocks SPA and full admin", async () => {
  const sql = createMockSql();
  const env = { EDGE_ADMIN_SECRET: TEST_SECRET };
  const headers = { [EDGE_ADMIN_HEADER]: TEST_SECRET };

  for (const allowedInternal of [
    "/api/v1/admin/ops/account-availability",
    "/api/v1/admin/ops/concurrency",
    "/api/v1/admin/accounts?page=1&page_size=200",
    "/api/v1/admin/accounts/12/chatgpt-inspection",
    "/api/v1/admin/accounts/12/test",
    "/api/v1/admin/accounts/12/schedulable",
    "/api/v1/admin/groups",
    "/api/v1/admin/groups/5",
    "/api/v1/admin/proxies",
    "/api/v1/admin/proxies/8/test",
  ]) {
    const res = await handleEdgeAdminGate(new Request(`https://pool.example${allowedInternal}`, { headers }), env, sql);
    assert.equal(res.allow, true, `expected internal allow for ${allowedInternal}`);
  }

  for (const blockedWithInternalSecret of [
    "/",
    "/login",
    "/admin",
    "/api/v1/auth/login",
    "/api/v1/admin/settings",
    "/api/v1/admin/users",
  ]) {
    const res = await handleEdgeAdminGate(new Request(`https://pool.example${blockedWithInternalSecret}`, { headers }), env, sql);
    assert.equal(res.response?.status, 404, `expected 404 even with internal secret for ${blockedWithInternalSecret}`);
  }

  // Issue + redeem break-glass ticket -> holder can load SPA, assets, login, and admin settings; revoke immediately blocks.
  let now = 1_700_000_000_000;
  const issue = await handleEdgeAdminGate(
    new Request("https://pool.example/__needtoken_edge/admin-gate/ticket", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ actor: "owner-1", reason: "oauth account binding", ttl_minutes: 20 }),
    }),
    env,
    sql,
    () => now,
  );
  assert.equal(issue.response?.status, 201);
  const { unlock_path: unlockPath } = await issue.response.json();
  const unlock = await handleEdgeAdminGate(new Request(`https://pool.example${unlockPath}`), env, sql, () => now);
  assert.equal(unlock.response?.status, 302);
  assert.equal(unlock.response.headers.get("location"), ADMIN_ENTRY_PATH);
  const cookiePair = unlock.response.headers.get("set-cookie").split(";")[0];
  assert.equal(cookiePair.startsWith(`${EDGE_ADMIN_COOKIE}=`), true);

  for (const path of ["/", "/login", "/assets/app.js", "/api/v1/auth/login", "/api/v1/admin/settings"]) {
    const ok = await handleEdgeAdminGate(
      new Request(`https://pool.example${path}`, { headers: { cookie: cookiePair } }),
      env,
      sql,
      () => now,
    );
    assert.equal(ok.allow, true, `expected break-glass allow for ${path}`);
  }

  await handleEdgeAdminGate(
    new Request("https://pool.example/__needtoken_edge/admin-gate/revoke", { method: "POST", headers }),
    env,
    sql,
    () => now,
  );
  const revoked = await handleEdgeAdminGate(
    new Request("https://pool.example/admin", { headers: { cookie: cookiePair } }),
    env,
    sql,
    () => now,
  );
  assert.equal(revoked.response?.status, 404);
});

test("edge secrets are excluded from container env and header stripping works", () => {
  const passed = containerEnv({
    AUTO_SETUP: "true",
    EDGE_ADMIN_SECRET: TEST_SECRET,
    DISABLE_PUBLIC_ADMIN: "1",
  });
  assert.deepEqual(passed, { AUTO_SETUP: "true" });

  const h = new Headers({ [EDGE_ADMIN_HEADER]: TEST_SECRET, "x-api-key": "k" });
  stripEdgeGateHeaders(h);
  assert.equal(h.get(EDGE_ADMIN_HEADER), null);
  assert.equal(h.get("x-api-key"), "k");
});
