# NeedToken Fork 开发与上游同步规则（needtoken-pool）

本仓是上游 `Wei-Shaw/sub2api` 的生产 Fork。技术栈为 Go 1.27.4（Ent + Gin）与 Vue 3 前端（`pnpm`），本地与 AI 开发必须遵守以下规则。

## 1. Remote 与分支规范

- `origin`：`NeedTokenAi/needtoken-pool`（日常推送与提 PR）。
- `upstream`：`Wei-Shaw/sub2api`（只读 `fetch`，本地必须 `git remote set-url --push upstream no_push` 禁止误推）。
- `main` 是唯一发布基线，**禁止本地直接 commit 或 push 到 `main`**；合入 `main` 会触发 Cloudflare Workers Builds 自动构建与发布。
- 日常开发一律在 `dev`（单线迭代）或 `feat/<topic>` / `fix/<topic>`（并行需求）进行，提 PR 合并进 `main`。
- 每次 PR 或上游同步合入 `main` 后，及时将 `origin/main` 合并/对齐回本地 `dev`，避免长期分叉。

## 2. 减少上游冲突的定制隔离原则

- NeedToken 专属定制优先放在**独立新增文件 / 独立目录**（如 `cloudflare/`、独立巡检/适配文件），对上游核心文件只做最小侵入式改动。
- **严禁**顺手格式化、重命名或重构与当前任务无关的上游代码。
- 后端修改必须通过 `go vet ./...`、`make test-unit`（与受影响集成测试），前端修改必须使用 `pnpm`（不要用 npm/yarn）并通过 `make test-frontend`。

## 3. 上游同步与自动合并红线

- 自动同步工作流：`.github/workflows/sync-upstream.yml`（默认通道 `stable-tags`，仅跟 `vMAJOR.MINOR.PATCH` 稳定语义化版本，最低底线 `UPSTREAM_MIN_TAG=v0.2.20`，不跟 `/releases/latest` 与预发布 tag）。
- **上游同步 PR（`sync/upstream/<40位sha>`）严禁 Squash / Rebase，必须使用 `Create a merge commit`**；Squash 会丢弃上游父提交并导致后续反复冲突。
- 非高危路径自动合并门禁：`.github/workflows/auto-merge-upstream.yml` 在受信任的 `main` 上以 `workflow_run` 运行，仅在 `CI`（`shell` / `test` / `frontend` / `golangci-lint` / `release-helpers`）与 `Security Scan`（`backend-security` / `frontend-security`）全部通过、双父 merge commit 校验通过、变更文件数未超阈值且未命中 `.github/upstream-sync/lib/high-risk-paths.sh` 高危路径时，自动执行 `Merge Commit` 并触发 Cloudflare 自动构建。
- 命中高危路径（`.github/`、`cloudflare/`、`deploy/`、`Dockerfile*`、`*.sql`、`backend/migrations/`、`backend/ent/schema/`、鉴权/中间件/配置/账务/订阅/代理核心服务）或产生冲突时，必须人工审阅与验证后再以 `Merge Commit` 合并；临时关闭自动合并请设置仓库 Variable `UPSTREAM_AUTO_MERGE=false`。
- 必须在仓库 Secrets 配置 `SYNC_GITHUB_TOKEN`（细粒度 PAT，`Contents: write` + `Pull requests: write`），以便自动开出的同步 PR 原生触发 `pull_request` CI 与 Security Scan。
