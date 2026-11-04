# NeedToken pool Cloud Run 部署

生产服务是 GCP 项目 `suichong`、区域 `asia-southeast1` 上的 Cloud Run 服务 `needtoken-pool`。历史冒烟地址是 `https://needtoken-pool-iipumltoca-as.a.run.app`（`/` 与 `/health`）。实际冒烟使用服务当前的 `status.url` 和 `candidate` 标签地址，不把历史主机名写死成唯一目标。

这条流水线只发布 **本仓库构建出来的镜像摘要**。部署引用形如：

```text
asia-southeast1-docker.pkg.dev/suichong/needtoken-pool/needtoken-pool@sha256:<64 hex>
```

仓库变量可以改项目、区域、服务名和 Artifact Registry 仓库名。工作流不会拉取 `Wei-Shaw/sub2api` 的 GitHub Release、Docker Hub 或 `ghcr.io` 镜像，也不会给 Cloud Run 写 `:latest`。

## 门禁

`.github/workflows/backend-ci.yml` 的工作流名是 `CI`。`main` 上每一次 push 和每一个 pull request 都会跑完全部作业。`required-checks` 只在这些作业全部成功时成功：

- `shell`
- `test`
- `frontend`
- `golangci-lint`
- `release-helpers`
- `ops-infra`

新增 CI 作业时，把它加进 `required-checks` 的 `needs`，以及 `.github/scripts/needtoken_ops.py` 里的 `REQUIRED_CHECK_JOBS`。`ops-infra` 会检查这份名单和 workflow 是否一致。

`Deploy Cloud Run` 使用 `workflow_run`，在名为 `CI` 的工作流完成之后启动。它会同时核对：

- 事件是 `push`，不是 pull request
- 分支是 `main`
- 结论是 `success`
- head 仓库是 `NeedTokenAi/needtoken-pool`
- `head_sha` 仍然等于当时的 `origin/main`

对不上的运行记为过期并跳过，不创建修订版，也不改流量。同一 SHA 的修订版如果已经承接 100% 流量，后续运行直接跳过。部署工作流的 concurrency 组是串行的，`cancel-in-progress` 为 false。

手动补跑使用 `workflow_dispatch`，输入 40 位 `git_sha`。这个 SHA 必须已经在 `main` 历史上，工作流文件本身必须来自 `refs/heads/main`。手动部署可以指向当前 main 之前的提交，用于把流量切回一个已经在 main 上的摘要。

在 GitHub 分支保护里把 `required-checks` 设为 `main` 的必过检查。这样未通过门禁的 PR 不能进入会触发部署的 main。

## 发布顺序

部署作业只在上面的门禁放行后拿到 `id-token: write`。顺序是：

1. 检出通过校验的固定 SHA，并确认 `HEAD` 就是这个 SHA。
2. 用 Workload Identity Federation 换取 GCP 身份。没有 JSON 密钥。
3. 若该 SHA 的修订版已经承接全部流量，结束。
4. 若修订版已存在但流量不是 100%，跳过构建，重新冒烟并提升流量。
5. 否则用根目录 `Dockerfile` 构建 `linux/amd64`，推送摘要，并额外推送不可变标签 `sha-<full sha>`。Cloud Run 只引用摘要。
6. `gcloud run services update --image <digest> --no-traffic --revision-suffix <full sha> --tag candidate`。
7. 比较更新前后的运行配置。环境变量、Secret、卷、服务账号、超时和并发必须保持原样。比较结果只打印字段路径，不打印值。
8. 确认新修订版流量是 0%，再请求 candidate 地址的 `/` 和 `/health`。`/health` 必须返回 200，且 JSON 里 `status` 为 `ok`。`/` 必须返回 200。私有服务遇到 401/403 时，再用身份令牌重试。
9. 提升流量之前再读一次 `origin/main`。自动部署发现 main 已前进时，把修订版留在 0% 并去掉 candidate 标签。
10. `gcloud run services update-traffic --to-revisions <revision>=100`。
11. 再冒烟服务自己的 URL。失败时把流量切回先前的修订版。
12. 去掉 candidate 标签，并在作业摘要里写上 SHA、摘要、修订版、冒烟结果和流量。

`gcloud run services update` 只改镜像、修订版后缀和 candidate 标签。工作流不调用 `services replace`，也不传会整表覆盖环境变量或 Secret 的参数。

修订版名是 `needtoken-pool-<40 位 sha>`。Cloud Run 修订版名上限 63 个字符，这个组合是 56。

## 还需要手工完成的身份

这些步骤不在本 PR 里执行，合并代码也不会创建 GCP 资源。在合并之后、期望自动部署成功之前做完。认证失败发生在 `services update` 之前，不会因为缺身份去改线上流量。

1. 在 `asia-southeast1` 创建 Docker 格式的 Artifact Registry 仓库，默认仓库 ID 是 `needtoken-pool`。
2. 创建部署用服务账号。不要生成 JSON 密钥。
3. 授权：
   - 对该 Artifact Registry 仓库授予 `roles/artifactregistry.writer`
   - 对 Cloud Run 服务 `needtoken-pool` 授予 `roles/run.developer`
   - 对 Cloud Run 运行时服务账号授予 `roles/iam.serviceAccountUser`。运行时账号可以用下面的命令查看，本仓库不记录它的邮箱：
     ```bash
     gcloud run services describe needtoken-pool \
       --project suichong \
       --region asia-southeast1 \
       --format='value(spec.template.spec.serviceAccountName)'
     ```
   - 若服务不匿名公开，再授予 `roles/run.invoker`，供冒烟时申请身份令牌
4. 创建 Workload Identity Pool，以及发行者为 `https://token.actions.githubusercontent.com` 的 OIDC Provider。属性映射至少包括：
   - `google.subject=assertion.sub`
   - `attribute.repository=assertion.repository`
   - `attribute.ref=assertion.ref`
   - `attribute.workflow_ref=assertion.workflow_ref`
5. Provider 条件限制到本仓库 main 上的部署工作流：
   ```text
   assertion.repository == 'NeedTokenAi/needtoken-pool'
   && assertion.ref == 'refs/heads/main'
   && assertion.workflow_ref == 'NeedTokenAi/needtoken-pool/.github/workflows/deploy-cloudrun.yml@refs/heads/main'
   ```
6. 只允许上述 principal 模拟部署服务账号。
7. 在 GitHub 仓库变量里写入：
   - `GCP_WORKLOAD_IDENTITY_PROVIDER`：`projects/<项目编号>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`
   - `GCP_SERVICE_ACCOUNT`：部署服务账号邮箱
   - 可选：`GCP_PROJECT_ID`（默认 `suichong`）、`GCP_REGION`（默认 `asia-southeast1`）、`CLOUD_RUN_SERVICE`（默认 `needtoken-pool`）、`ARTIFACT_REGISTRY_REPOSITORY`（默认 `needtoken-pool`）

变量可以放在仓库变量里。不要把 JSON 密钥放进 Secrets，工作流也没有读取这类密钥的步骤。

## 需要停用的其他发布路径

Cloud Run 上如果还开着从本仓库或官方镜像自动部署的通道，它会和这条摘要发布抢修订版。

- GCP Console → Cloud Build → Triggers：停用所有会构建本仓库或部署 `needtoken-pool` 的触发器，包括从 Cloud Run 页面打开的持续部署。
- Cloud Run → `needtoken-pool`：断开 Continuous deployment。
- GitHub Actions 里停用名为 `Release` 的工作流。它来自上游，在推送 `v*` tag 时发布镜像。NeedToken 的生产镜像只由 `Deploy Cloud Run` 从固定 SHA 构建。不要为了上线去推官方式 tag。
- 管理后台的一键更新仍然查询 `Wei-Shaw/sub2api` 的 GitHub Release，并替换容器里的二进制。这条产品路径没有在本次改动里重写。生产环境不要使用它，也不要改成官方 `latest` 镜像。下一次 Cloud Run 修订会回到本仓库构建的摘要。

`Security Scan` 继续单独运行，不作为这次部署门禁。部署门禁是 `CI` 的 `required-checks`。上游合并方式见 [upstream-sync.md](./upstream-sync.md)。
