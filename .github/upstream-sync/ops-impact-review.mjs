#!/usr/bin/env node
// NeedToken Ops 契约静态画像 + Cloudflare AI Gateway 风险研判 + Ops 签名 Webhook 通知
// 零第三方依赖，仅使用 Node.js 内置模块，适用于 CI 与同步冲突研判。

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMENT_MARKER = "<!-- needtoken-ops-impact-report -->";

const MODULE_PROFILES = {
  storefront: {
    label: "店面系统 (needtoken-storefront)",
    opsContractPatterns: [
      /^internal\/modules\/(opsbridge|upstreamapi|diagnostics)\//,
      /^internal\/app\/httpserver\/routes_(channel|upstream|storefront)\.go$/,
      /^cloudflare\//,
      /^frontend\/user\/src\/templates\/needtoken\//,
    ],
    dbMigrationPatterns: [
      /\.sql$/i,
      /(?:^|\/)migrations\//i,
      /^internal\/(models|database)\//,
      /\/gormstore\//,
    ],
  },
  newapi: {
    label: "API 网关 (needtoken-api)",
    opsContractPatterns: [
      /^controller\/(subscription|redemption|channel|user|needtoken_|external_grant)/,
      /^router\/(api-router|channel-router)\.go$/,
      /^middleware\//,
      /^cloudflare\//,
    ],
    dbMigrationPatterns: [
      /\.sql$/i,
      /(?:^|\/)migrations\//i,
      /^model\//,
    ],
  },
  pool: {
    label: "供给号池 (needtoken-pool)",
    opsContractPatterns: [
      /^backend\/internal\/server\/routes\/(admin|gateway)\.go$/,
      /^backend\/internal\/handler\/admin\//,
      /^backend\/internal\/service\/.*(?:proxy|account|group|ops|openai_responses)/,
      /^cloudflare\//,
    ],
    dbMigrationPatterns: [
      /\.sql$/i,
      /^backend\/migrations\//,
      /^backend\/ent\/schema\//,
    ],
  },
};

const DESTRUCTIVE_DB_PATTERN =
  /\b(?:DROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|VIEW)|ALTER\s+TABLE\b[^\n;]*\b(?:DROP|ALTER\s+COLUMN|RENAME|TYPE)\b|TRUNCATE\s+TABLE|DELETE\s+FROM|RENAME\s+(?:TABLE|COLUMN))\b/i;

const SECRET_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|config\.ya?ml|secrets?\.json|.*\.pem|.*\.key)$/i;

export function classifyDbMigrationRisk(files, diffText = "") {
  const dbFiles = files.filter((file) =>
    /\.sql$/i.test(file) ||
    /(?:^|\/)migrations\//i.test(file) ||
    /^backend\/ent\/schema\//.test(file) ||
    /^model\//.test(file) ||
    /^internal\/(models|database)\//.test(file),
  );
  if (dbFiles.length === 0) {
    return { risk: "none", dbFiles: [], destructiveSignals: [] };
  }
  const destructiveSignals = [];
  for (const line of String(diffText).split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (DESTRUCTIVE_DB_PATTERN.test(line)) {
      destructiveSignals.push(line.slice(1).trim().slice(0, 140));
    }
  }
  if (destructiveSignals.length > 0) {
    return {
      risk: "destructive_irreversible",
      dbFiles,
      destructiveSignals: destructiveSignals.slice(0, 10),
    };
  }
  return { risk: "additive_safe", dbFiles, destructiveSignals: [] };
}

export function buildStaticImpactAssessment({
  moduleName,
  event = "impact_review",
  files = [],
  highRiskFiles = [],
  conflictFiles = [],
  diffText = "",
  contractCheckStatus = "unknown",
}) {
  const profile = MODULE_PROFILES[moduleName] ?? MODULE_PROFILES.storefront;
  const opsTouched = files.filter((f) => profile.opsContractPatterns.some((re) => re.test(f)));
  const db = classifyDbMigrationRisk(files, diffText);

  let verdict = "safe";
  const reasons = [];

  if (event === "sync_conflict" || conflictFiles.length > 0) {
    verdict = "block";
    reasons.push(`存在 ${conflictFiles.length} 个合并冲突文件，需先人工解冲突后再走 Merge Commit 审阅`);
  }
  if (contractCheckStatus === "failed") {
    verdict = "block";
    reasons.push("Ops 契约或边缘门禁冒烟检查未通过");
  }
  if (db.risk === "destructive_irreversible") {
    verdict = "block";
    reasons.push(`检测到可能不可逆的数据库结构变更（${db.dbFiles.length} 个文件）`);
  } else if (db.risk === "additive_safe" && verdict === "safe") {
    verdict = "caution";
    reasons.push(`包含 ${db.dbFiles.length} 个数据库模型/迁移变更（增量型，升级前需核对兼容三库/回滚策略）`);
  }
  if (opsTouched.length > 0 && verdict === "safe") {
    verdict = "caution";
    reasons.push(`涉及 ${opsTouched.length} 个 Ops/Glue 关键契约或边缘路径`);
  }
  if (highRiskFiles.length > 0 && verdict === "safe") {
    verdict = "caution";
    reasons.push(`命中 ${highRiskFiles.length} 个高危保护路径`);
  }
  if (reasons.length === 0) {
    reasons.push(`变更 ${files.length} 个文件，未触及 Ops 契约、高危二开路径或数据库迁移`);
  }

  const attentionFiles = [...new Set([...conflictFiles, ...db.dbFiles, ...opsTouched, ...highRiskFiles])].slice(0, 20);

  return {
    verdict,
    summary_zh: reasons.join("；"),
    ops_impact:
      opsTouched.length > 0
        ? `触及 Ops/Glue 相关文件：${opsTouched.slice(0, 8).join(", ")}`
        : "未直接修改 Ops/Glue 契约路由与边缘门禁目录。",
    db_migration_risk: db.risk,
    db_migration_notes:
      db.risk === "destructive_irreversible"
        ? `命中破坏性 DDL/Schema 信号：${db.destructiveSignals.join(" | ")}`
        : db.risk === "additive_safe"
          ? `涉及模型或迁移文件：${db.dbFiles.slice(0, 8).join(", ")}`
          : "无数据库结构或迁移变更，支持 Cloudflare Worker 秒级无痛回滚。",
    attention_files: attentionFiles,
    recommendation_zh:
      verdict === "block"
        ? "暂缓合并，请先排查阻断项并完成人工核验。"
        : verdict === "caution"
          ? "需人工复核关键变更文件与 CI 结果后再通过 Ops 审批 Merge Commit。"
          : "静态画像与契约检查均正常，确认 CI 全绿后可通过 Ops 审批 Merge Commit。",
  };
}

function rankDbRisk(risk) {
  if (risk === "destructive_irreversible") return 2;
  if (risk === "additive_safe") return 1;
  return 0;
}

function rankVerdict(verdict) {
  if (verdict === "block") return 2;
  if (verdict === "caution") return 1;
  return 0;
}

// Fail-closed merge: LLM can elevate warnings or explain nuances, but can never
// downgrade a static destructive DB risk or a static conflict/contract failure.
export function parseAiReviewJson(rawText, fallback) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return { ...fallback, ai_status: "fallback_empty" };
  }
  let cleaned = rawText.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) cleaned = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return { ...fallback, ai_status: "fallback_invalid_json" };
      }
    } else {
      return { ...fallback, ai_status: "fallback_invalid_json" };
    }
  }
  const aiVerdict = ["safe", "caution", "block"].includes(parsed.verdict) ? parsed.verdict : fallback.verdict;
  const aiDbRisk = ["none", "additive_safe", "destructive_irreversible"].includes(parsed.db_migration_risk)
    ? parsed.db_migration_risk
    : fallback.db_migration_risk;

  const finalDbRisk = rankDbRisk(aiDbRisk) >= rankDbRisk(fallback.db_migration_risk) ? aiDbRisk : fallback.db_migration_risk;
  const finalVerdict = rankVerdict(aiVerdict) >= rankVerdict(fallback.verdict) ? aiVerdict : fallback.verdict;

  return {
    verdict: finalVerdict,
    summary_zh: typeof parsed.summary_zh === "string" && parsed.summary_zh.trim() ? parsed.summary_zh.trim().slice(0, 400) : fallback.summary_zh,
    ops_impact: typeof parsed.ops_impact === "string" && parsed.ops_impact.trim() ? parsed.ops_impact.trim().slice(0, 600) : fallback.ops_impact,
    db_migration_risk: finalDbRisk,
    db_migration_notes:
      typeof parsed.db_migration_notes === "string" && parsed.db_migration_notes.trim()
        ? parsed.db_migration_notes.trim().slice(0, 600)
        : fallback.db_migration_notes,
    attention_files: Array.isArray(parsed.attention_files)
      ? [...new Set([...parsed.attention_files.filter((x) => typeof x === "string").slice(0, 15), ...fallback.attention_files])].slice(0, 20)
      : fallback.attention_files,
    recommendation_zh:
      typeof parsed.recommendation_zh === "string" && parsed.recommendation_zh.trim()
        ? parsed.recommendation_zh.trim().slice(0, 400)
        : fallback.recommendation_zh,
    ai_status: "completed",
  };
}

export async function callAiGateway({
  gatewayUrl,
  apiKey,
  cfAigToken = "",
  model = "xai/grok-3-mini",
  promptContext,
  fallback,
  fetchImpl = fetch,
}) {
  if (!gatewayUrl || !apiKey) {
    return { ...fallback, ai_status: "not_configured", ai_model: "" };
  }
  const systemPrompt = [
    "你是 NeedTokenAi 平台的资深发布与安全评审工程师。",
    "你需要基于上游升级 diff 或合并冲突信息，客观评估本次升级对 NeedToken Ops 后台、Glue 履约、边缘门禁与数据库回滚的影响。",
    "严格只输出一个 JSON 对象，不要包含额外文字，字段固定为：",
    '{"verdict":"safe|caution|block","summary_zh":"一句话中文结论","ops_impact":"对 Ops/Glue 的影响","db_migration_risk":"none|additive_safe|destructive_irreversible","db_migration_notes":"数据库兼容与回滚评估","attention_files":["关键文件"],"recommendation_zh":"明确的中文处理建议"}',
  ].join("\n");

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (cfAigToken) {
    headers["cf-aig-authorization"] = `Bearer ${cfAigToken}`;
  }

  const send = async (withResponseFormat) => {
    const body = {
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptContext },
      ],
    };
    if (withResponseFormat) {
      body.response_format = { type: "json_object" };
    }
    return fetchImpl(gatewayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  };

  try {
    let response = await send(true);
    if (response.status === 400) {
      response = await send(false);
    }
    if (!response.ok) {
      return { ...fallback, ai_status: `gateway_http_${response.status}`, ai_model: model };
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const merged = parseAiReviewJson(content, fallback);
    return { ...merged, ai_model: model };
  } catch (err) {
    return { ...fallback, ai_status: `gateway_error:${err?.name || "unknown"}`, ai_model: model };
  }
}

export function signWebhookPayload(secret, timestampSec, rawBody) {
  const sig = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
  return `sha256=${sig}`;
}

export async function postOpsWebhook({
  webhookUrl,
  webhookSecret,
  payload,
  nowSec = () => Math.floor(Date.now() / 1000),
  fetchImpl = fetch,
}) {
  if (!webhookUrl || !webhookSecret) {
    return { sent: false, reason: "not_configured" };
  }
  const ts = String(nowSec());
  const rawBody = JSON.stringify(payload);
  const signature = signWebhookPayload(webhookSecret, ts, rawBody);
  try {
    const resp = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-needtoken-release-timestamp": ts,
        "x-needtoken-release-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return { sent: false, status: resp.status, reason: `http_${resp.status}` };
    }
    return { sent: true, status: resp.status };
  } catch (err) {
    return { sent: false, reason: err?.name || "network_error" };
  }
}

export function renderPrCommentMarkdown(report) {
  const verdictBadge =
    report.verdict === "safe"
      ? "✅ SAFE（低风险，CI 全绿后可在 Ops 批准 Merge Commit）"
      : report.verdict === "caution"
        ? "⚠️ CAUTION（需人工复核关键改动后再在 Ops 批准合并）"
        : "🛑 BLOCK（存在阻断风险或不可逆迁移，请人工排查后再决定）";

  const dbBadge =
    report.db_migration_risk === "destructive_irreversible"
      ? "🔴 `destructive_irreversible`（含可能不可逆结构变更，回滚前必须评估数据库兼容性）"
      : report.db_migration_risk === "additive_safe"
        ? "🟡 `additive_safe`（增量型结构/模型变更）"
        : "🟢 `none`（无数据库迁移，支持 Cloudflare Worker 秒级无痛回滚）";

  const filesBlock =
    report.attention_files?.length > 0
      ? report.attention_files.map((f) => `- \`${f}\``).join("\n")
      : "- （无重点高危文件）";

  return [
    COMMENT_MARKER,
    `### NeedToken Ops 影响评估与 AI 风险研判（${report.module}）`,
    "",
    `- **综合判定**：${verdictBadge}`,
    `- **数据库迁移风险**：${dbBadge}`,
    `- **契约/门禁检查**：\`${report.contract_check_status || "unknown"}\``,
    `- **AI 研判引擎**：\`${report.ai_status}\`${report.ai_model ? `（\`${report.ai_model}\`）` : ""}`,
    "",
    `#### 中文结论`,
    report.summary_zh,
    "",
    `#### Ops 与 Glue 契约影响`,
    report.ops_impact,
    "",
    `#### 数据库迁移与回滚说明`,
    report.db_migration_notes,
    "",
    `#### 重点关注文件`,
    filesBlock,
    "",
    `#### 操作建议`,
    report.recommendation_zh,
    "",
    `> 合并上游同步 PR 时请务必在 Ops 或 GitHub 使用 **Create a merge commit**，严禁 Squash 或 Rebase。`,
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function safeGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function buildCompactDiff(baseRef, headRef, focusFiles) {
  const filtered = focusFiles.filter((f) => !SECRET_FILE_PATTERN.test(f) && !f.endsWith("-lock.yaml") && !f.endsWith("package-lock.json"));
  if (filtered.length === 0) return "";
  const raw = safeGit(["diff", "--unified=2", baseRef, headRef, "--", ...filtered.slice(0, 25)]);
  return raw.slice(0, 22_000);
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "pr";
  const moduleName = args.module || process.env.NEEDTOKEN_MODULE || "storefront";
  const repo = args.repo || process.env.GITHUB_REPOSITORY || "";
  const upstreamRepo = args["upstream-repo"] || process.env.UPSTREAM_REPO || "";
  const tag = args.tag || process.env.UPSTREAM_TAG || "";
  const baseSha = args["base-sha"] || process.env.BASE_SHA || "";
  const headSha = args["head-sha"] || process.env.HEAD_SHA || "";
  const prNumber = args["pr-number"] ? Number(args["pr-number"]) : Number(process.env.PR_NUMBER || 0);
  const prUrl = args["pr-url"] || process.env.PR_URL || "";
  const runUrl = args["run-url"] || process.env.RUN_URL || "";
  const contractStatus = args["contract-status"] || process.env.CONTRACT_CHECK_STATUS || "unknown";
  const outJson = args["out-json"] || "ops-impact-report.json";
  const outMd = args["out-md"] || "";

  let files = [];
  let highRiskFiles = [];
  let conflictFiles = [];
  let diffText = "";
  let commitsText = "";
  let mergeSummary = "";
  let event = "impact_review";

  if (mode === "conflict") {
    event = "sync_conflict";
    conflictFiles = (args["conflict-files"] || "")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    files = conflictFiles;
    if (args["merge-log-file"]) {
      try {
        mergeSummary = readFileSync(args["merge-log-file"], "utf8").slice(0, 6000);
      } catch {
        mergeSummary = "";
      }
    }
  } else if (mode === "opened") {
    event = "sync_pr_opened";
    if (baseSha && headSha) {
      files = safeGit(["diff", "--name-only", baseSha, headSha]).split("\n").filter(Boolean);
      commitsText = safeGit(["log", "--oneline", "-n", "30", `${baseSha}..${headSha}`]);
    }
  } else {
    event = "impact_review";
    if (baseSha && headSha) {
      files = safeGit(["diff", "--name-only", baseSha, headSha]).split("\n").filter(Boolean);
      commitsText = safeGit(["log", "--oneline", "-n", "40", `${baseSha}..${headSha}`]);
      const profile = MODULE_PROFILES[moduleName] ?? MODULE_PROFILES.storefront;
      const priorityFiles = files.filter(
        (f) =>
          profile.opsContractPatterns.some((re) => re.test(f)) ||
          profile.dbMigrationPatterns.some((re) => re.test(f)),
      );
      diffText = buildCompactDiff(baseSha, headSha, priorityFiles.length > 0 ? priorityFiles : files.slice(0, 15));
    }
    if (args["high-risk-file"]) {
      try {
        highRiskFiles = readFileSync(args["high-risk-file"], "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
      } catch {
        highRiskFiles = [];
      }
    }
  }

  const staticAssessment = buildStaticImpactAssessment({
    moduleName,
    event,
    files,
    highRiskFiles,
    conflictFiles,
    diffText,
    contractCheckStatus: contractStatus,
  });

  const promptContext = [
    `模块: ${moduleName} (${repo})`,
    `事件类型: ${event}`,
    `上游来源: ${upstreamRepo} ${tag}`,
    `变更文件数: ${files.length}`,
    `冲突文件: ${conflictFiles.join(", ") || "无"}`,
    `高危命中文件: ${highRiskFiles.join(", ") || "无"}`,
    `静态初判: ${JSON.stringify(staticAssessment)}`,
    commitsText ? `提交摘要:\n${commitsText}` : "",
    mergeSummary ? `合并冲突日志:\n${mergeSummary}` : "",
    diffText ? `精选关键 Diff（已脱敏截断）:\n${diffText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const aiResult =
    mode === "opened"
      ? { ...staticAssessment, ai_status: "deferred_to_pr_ci", ai_model: "" }
      : await callAiGateway({
          gatewayUrl: (process.env.AI_GATEWAY_URL || "").trim(),
          apiKey: (process.env.AI_GATEWAY_API_KEY || "").trim(),
          cfAigToken: (process.env.CF_AIG_TOKEN || "").trim(),
          model: (process.env.AI_REVIEW_MODEL || "xai/grok-3-mini").trim(),
          promptContext,
          fallback: staticAssessment,
        });

  const report = {
    schema_version: 1,
    event,
    module: moduleName,
    repo,
    upstream_repo: upstreamRepo,
    tag,
    base_sha: baseSha,
    head_sha: headSha,
    pr_number: prNumber > 0 ? prNumber : undefined,
    pr_url: prUrl || undefined,
    run_url: runUrl || undefined,
    changed_files_count: files.length,
    conflict_files: conflictFiles,
    high_risk_files: highRiskFiles.slice(0, 30),
    contract_check_status: contractStatus,
    ...aiResult,
    generated_at: new Date().toISOString(),
  };

  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (outMd) {
    writeFileSync(outMd, `${renderPrCommentMarkdown(report)}\n`, "utf8");
  }

  const webhookResult = await postOpsWebhook({
    webhookUrl: (process.env.OPS_RELEASE_WEBHOOK_URL || "").trim(),
    webhookSecret: (process.env.OPS_RELEASE_WEBHOOK_SECRET || "").trim(),
    payload: report,
  });
  if (!webhookResult.sent && webhookResult.reason !== "not_configured") {
    console.warn(`::warning::Ops release webhook notification failed: ${webhookResult.reason}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
  await runCli();
}
