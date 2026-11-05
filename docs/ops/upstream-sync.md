# 上游同步

NeedToken pool 跟踪 `Wei-Shaw/sub2api`。同步工作流把上游频道解析成一个固定 commit SHA，再向 `main` 打开一个普通 merge PR。它不登录 GCP，不构建镜像，也不部署 Cloud Run。

工作流文件是 `.github/workflows/sync-upstream.yml`。

- 定时：`0 0 * * *`，GitHub 按 UTC 计算，也就是每天 00:00 UTC
- 手动：`workflow_dispatch`，可用 `channel` 临时覆盖仓库变量

并发组串行执行，不会取消已经开始的同步。

## 频道

仓库变量 `UPSTREAM_CHANNEL` 决定解析哪一个上游 ref。手动运行时，输入的 `channel` 优先于变量。

| 值 | 解析结果 |
| --- | --- |
| `release`、`stable`、`latest` | `Wei-Shaw/sub2api` 最新正式 GitHub Release 的 tag |
| `v1.2.3` 或 `refs/tags/v1.2.3` | 这一个 tag |
| `main` 或 `refs/heads/main` | 这个分支在解析当时的 tip |

解析用 `git ls-remote` 只查询这一条 ref。附注 tag 会剥到 commit。随后 `git fetch --no-tags` 也只取这一条 ref。ref 在查询和 fetch 之间如果变了，本次同步失败，不会去跟另一个 SHA。

本仓库的历史是沿上游 `main` 合并的，因此日常频道用 `main`。要跟官方版本号时把变量设为 `release`。变量为空时工作流失败并停止，避免默默同步错误的线。

如果这个 SHA 已经是 `origin/main` 的祖先，工作流只在摘要里记录跳过。

## 一个 PR

同一时间只保留一个 `sync/upstream/*` PR。

- 目标分支已有本次 SHA 的 PR 或远程分支：不重复推送，只补齐 merge auto-merge。
- 已经有另一个 SHA 的 sync PR：不打开第二个。若配置了 `SYNC_GITHUB_TOKEN`，会在旧 PR 上评论一次新的 SHA。
- 都没有：从当时的 `origin/main` 建分支 `sync/upstream/<40 位 sha>`，用 `git merge --no-ff` 生成普通 merge commit，父提交同时保留 main 和上游 SHA。

推送只包含 `refs/heads/sync/upstream/<sha>`。工作流没有 `git push --tags`、`--all` 或批量 tag refspec。

干净 PR 的正文要求用 merge commit 合并。默认 `UPSTREAM_AUTO_MERGE=true` 时，工作流执行 `gh pr merge --merge --auto`，检查通过后使用 merge commit。把仓库变量 `UPSTREAM_AUTO_MERGE` 设为 `false` 可以只开 PR、不自动合并。仓库需要允许 merge commit，并打开 Allow auto-merge。在把 `required-checks` 设为 `main` 的必过检查之前，先把 `UPSTREAM_AUTO_MERGE` 设为 `false`，否则没有必过检查时 PR 可能在打开后立即合并。

## 冲突交给 Codex

合并出现冲突时：

- 记录冲突文件
- `git merge --abort`
- 确认工作区干净，且没有残留的冲突标记
- 不创建提交，不推送 `sync/upstream/<sha>`
- 打开或复用 issue，标题是 `upstream sync conflict at <sha>`

issue 里包含频道、解析出的版本、固定 SHA、`main` SHA 和冲突文件列表，供 Codex 在本地合并该 SHA、解决这些文件后，再推送普通 merge commit 并打开一个 PR。

## SYNC_GITHUB_TOKEN

GitHub 默认的 `GITHUB_TOKEN` 推送分支不会再次触发 `CI`。干净同步必须用 secret `SYNC_GITHUB_TOKEN` 推送，PR 上的 CI 才会运行，auto-merge 也才等得到 `required-checks`。

这个 secret 使用只针对 `NeedTokenAi/needtoken-pool` 的 fine-grained PAT 或 GitHub App installation token：

- Contents: Read and write
- Pull requests: Read and write
- 不授予 GCP 角色，不放进部署工作流

冲突 issue 使用工作流自带的 `GITHUB_TOKEN` 和 `issues: write`。同步 workflow 的权限是 `contents: read`、`issues: write`、`pull-requests: read`，没有 `id-token: write`。

同步 PR 合并进 `main` 之后，才会由 `CI` 成功触发 `Deploy Cloud Run`。同步作业本身不持有云身份。部署身份和需要停用的 Cloud Build / 官方发布见 [deploy.md](./deploy.md)。
