#!/usr/bin/env bash
# 判定 needtoken-pool 上游同步 PR 改动路径是否命中高危路径（fail-closed）。
# 涵盖 CI/工作流、Cloudflare/容器部署、数据库迁移与 Ent schema、鉴权、账务/订阅与代理巡检核心路径。

is_high_risk_path() {
  local path=$1
  case "$path" in
    # CI / 工作流 / 供应链与规则文件
    .github/* | .agents/rules/needtoken-fork.md)
      return 0
      ;;
    # 容器 / Cloudflare 部署边界 / deploy 脚本与配置
    cloudflare/* | deploy/* | Dockerfile | Dockerfile.* | */Dockerfile | */Dockerfile.* | \
      docker-compose*.yml | compose*.yml | .goreleaser*.yaml)
      return 0
      ;;
    # 任意 SQL 脚本 / 数据库迁移 / Ent schema
    *.sql | backend/migrations/* | backend/ent/schema/* | */migrations/* | migrations/*)
      return 0
      ;;
    # 鉴权 / 中间件 / 核心配置 / 账务 / 订阅 / 充值 / 代理核心逻辑
    backend/internal/middleware/* | backend/internal/config/* | \
      backend/internal/handler/*auth* | backend/internal/handler/*billing* | \
      backend/internal/handler/*payment* | backend/internal/handler/*subscription* | \
      backend/internal/handler/*redeem* | backend/internal/handler/*wallet* | \
      backend/internal/service/*auth* | backend/internal/service/*billing* | \
      backend/internal/service/*payment* | backend/internal/service/*subscription* | \
      backend/internal/service/*redeem* | backend/internal/service/*wallet* | \
      backend/internal/service/*proxy*)
      return 0
      ;;
    # NeedToken 二开保护区（Ops/Glue 契约路由、版本文件与定制单测）
    backend/internal/server/routes/admin.go | backend/internal/server/routes/gateway.go | \
      backend/internal/handler/admin/ops* | backend/internal/pkg/adminaccess/catalog.go | \
      backend/internal/service/openai_responses_orphan_precheck_test.go | \
      backend/cmd/server/VERSION)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

filter_high_risk_paths() {
  local line
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    if is_high_risk_path "$line"; then
      printf '%s\n' "$line"
    fi
  done
}
