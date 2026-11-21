import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMENT_MARKER,
  buildStaticImpactAssessment,
  callAiGateway,
  classifyDbMigrationRisk,
  parseAiReviewJson,
  postOpsWebhook,
  renderPrCommentMarkdown,
  signWebhookPayload,
} from "./ops-impact-review.mjs";

test("classifies DB migrations accurately and detects destructive DDL", () => {
  assert.equal(classifyDbMigrationRisk(["README.md", "frontend/user/src/App.vue"]).risk, "none");
  assert.equal(
    classifyDbMigrationRisk(
      ["internal/models/product.go"],
      "+ALTER TABLE products ADD COLUMN subtitle TEXT;",
    ).risk,
    "additive_safe",
  );
  const destructive = classifyDbMigrationRisk(
    ["migrations/012_drop_legacy.sql"],
    "+ALTER TABLE orders DROP COLUMN legacy_ref;",
  );
  assert.equal(destructive.risk, "destructive_irreversible");
  assert.equal(destructive.destructiveSignals.length, 1);
});

test("AI review parser fails closed and never downgrades destructive DB risk or block verdict", () => {
  const staticBlock = buildStaticImpactAssessment({
    moduleName: "storefront",
    files: ["migrations/012_drop.sql", "internal/modules/opsbridge/service.go"],
    diffText: "+DROP TABLE legacy_orders;",
    contractCheckStatus: "passed",
  });
  assert.equal(staticBlock.verdict, "block");
  assert.equal(staticBlock.db_migration_risk, "destructive_irreversible");

  const merged = parseAiReviewJson(
    '```json\n{"verdict":"safe","summary_zh":"看似安全","db_migration_risk":"none","ops_impact":"无","db_migration_notes":"无","attention_files":[],"recommendation_zh":"直接合并"}\n```',
    staticBlock,
  );
  assert.equal(merged.verdict, "block");
  assert.equal(merged.db_migration_risk, "destructive_irreversible");
  assert.equal(merged.ai_status, "completed");
});

test("Cloudflare AI Gateway call sends cf-aig-authorization and gracefully falls back when unconfigured", async () => {
  const fallback = buildStaticImpactAssessment({ moduleName: "storefront", files: ["README.md"] });
  const unconfigured = await callAiGateway({ gatewayUrl: "", apiKey: "", promptContext: "x", fallback });
  assert.equal(unconfigured.ai_status, "not_configured");

  let capturedHeaders;
  const mockFetch = async (_url, init) => {
    capturedHeaders = init.headers;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "caution",
                summary_zh: "需关注商品接口变更",
                ops_impact: "轻微影响",
                db_migration_risk: "none",
                db_migration_notes: "无迁移",
                attention_files: ["internal/app/httpserver/routes_channel.go"],
                recommendation_zh: "复核后合并",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const reviewed = await callAiGateway({
    gatewayUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions",
    apiKey: "xai-test-key",
    cfAigToken: "cf-aig-secret",
    model: "xai/grok-3-mini",
    promptContext: "diff",
    fallback,
    fetchImpl: mockFetch,
  });
  assert.equal(capturedHeaders["cf-aig-authorization"], "Bearer cf-aig-secret");
  assert.equal(capturedHeaders.authorization, "Bearer xai-test-key");
  assert.equal(reviewed.verdict, "caution");
  assert.equal(reviewed.summary_zh, "需关注商品接口变更");
});

test("signs Ops release webhook with HMAC-SHA256 and renders PR markdown with marker", async () => {
  let sent;
  const res = await postOpsWebhook({
    webhookUrl: "https://ops.example/internal/release-governance/v1/webhook",
    webhookSecret: "w".repeat(40),
    payload: { module: "storefront", verdict: "safe" },
    nowSec: () => 1700000000,
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: init.body };
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.equal(res.sent, true);
  assert.equal(
    sent.headers["x-needtoken-release-signature"],
    signWebhookPayload("w".repeat(40), "1700000000", sent.body),
  );

  const md = renderPrCommentMarkdown({
    module: "storefront",
    verdict: "safe",
    db_migration_risk: "none",
    contract_check_status: "passed",
    ai_status: "completed",
    ai_model: "xai/grok-3-mini",
    summary_zh: "无风险",
    ops_impact: "无影响",
    db_migration_notes: "无迁移",
    attention_files: [],
    recommendation_zh: "可合并",
  });
  assert.equal(md.startsWith(COMMENT_MARKER), true);
  assert.equal(md.includes("Create a merge commit"), true);
});
