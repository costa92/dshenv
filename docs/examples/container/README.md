# 容器示例：在 Docker 中运行 DSH Web

## 1. 用途

`Dockerfile` 在构建期把当前 dshenv 源码打包安装，`COPY` 配置仓库的 `envctl/` 到镜像内，然后运行 `dshenv apply --yes` 装好清单声明的插件、`dshenv plan` 确认无漂移；容器启动后执行 `dsh web`，提供带 Web UI 的 DSH 服务。改插件配置需要重新构建镜像，容器本身不做任何写清单操作。

## 2. 目录约定

本目录的 `Dockerfile`、`cordis.patch.yml`、`compose.yaml`、`.dockerignore` 要复制到你的配置仓库根目录，与该仓库已有的 `envctl/manifest.yaml`（可选 `lock.json`、`overlays/`）放在一起：

```
your-config-repo/
├── .dockerignore
├── Dockerfile
├── cordis.patch.yml
├── compose.yaml
└── envctl/
    ├── manifest.yaml
    ├── lock.json          # 可选
    └── overlays/          # 可选
```

清单中要使用的 profile 名固定为 `web`，因为镜像启动命令是 `dsh web`。

`.dockerignore` 不能省：`Dockerfile` 会 `COPY` 整个 `envctl/`，而本机用过 dshenv 的配置仓库里可能还有 `state.json`、`overlay-selection.json`、`dshenv.lock`、`backups/`、`logs/`、`trash/`、`sources/`、`remote.json`、`remote/` 等本机状态，以及 `run/`（`web start` 的记录，含带 token 的 dsh web 登录地址）。它们会让镜像内的 `apply`/`plan` 依赖本机状态而不只是清单，`.dockerignore` 把它们（以及 `.git`）排除在构建上下文之外，`run/` 若进了镜像层，token 会随镜像分发。

## 3. 构建与运行

```bash
docker build --build-context dshenv=/path/to/dshenv -t my-dsh .
docker network create dsh-net   # 独立网络，见第 4 节
docker run --rm --network dsh-net -p 127.0.0.1:3080:3080 -e DEEPSEEK_API_KEY my-dsh
# 或
DSHENV_SRC=/path/to/dshenv DEEPSEEK_API_KEY=... docker compose up --build
```

镜像从源码构建 dshenv（因此可以使用未发布的改动），`--build-context dshenv=...`（或 compose 的 `DSHENV_SRC`）必须指向一份 dshenv 源码检出，构建阶段会从中打包安装。只用已发布版本时，建议检出对应的 tag（如 `git -C /path/to/dshenv checkout v<版本>`），不要直接用 `master`；也可以把 `Dockerfile` 的 `dshenv-build` 阶段换成 `npm install -g @costa92/dshenv@<版本>`。

启动后在 `docker logs <容器名>`（或 `docker compose logs dsh`）里找 `dsh web: http://127.0.0.1:3080/?token=...` 链接完成首次认证：

- 同一行还会打印 `LAN: http://172.x.x.x:3080/?token=...`，那是容器网络内的地址，宿主机回环发布下用不上，也不要转发或分享（它带着 token）。
- 认证 cookie 绑定登录时使用的地址：用 `127.0.0.1` 登录后改用 `localhost`（或反之）会再次 401，需要重新打开 token 链接。
- 链接里的端口是容器内的 `3080`。宿主机映射到其他端口（例如 `127.0.0.1:13080:3080`）时，把链接里的端口改成宿主机端口再打开。

可复现性：`NODE_VERSION` 只固定大版本，需要逐字节可复现时把基础镜像改成 `node:22-slim@sha256:<digest>`。`npm install -g @deepseek-ai/dsh@${DSH_VERSION}` 只固定 DSH 本身，其依赖按版本范围解析、没有 lockfile，不同时间构建可能装到不同的依赖版本。

构建参数：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DSH_VERSION` | `0.1.7-rc.2` | 已验证的版本（2026-09-29 也是 npm 上的 `latest`）；换版本前先按 [DSH 新版本兼容验证](../../DSH版本升级.md) 验证 |
| `PNPM_VERSION` | `10.30.3` | 与仓库 CI 一致 |
| `NODE_VERSION` | `22` | 基础镜像 `node:${NODE_VERSION}-slim` |
| `DSHENV_OVERLAY` | 空 | 非空时对应 `envctl/overlays/<name>.yaml`，构建期 `apply`/`plan` 会带上 `--overlay`；为空时带 `--no-overlay`，不读 `envctl/overlay-selection.json` |

构建期选用的 overlay 不会写进镜像：镜像内没有 `overlay-selection.json`，在用 overlay 构建的容器里手动跑 `dshenv plan` 时必须带同一个 `--overlay <name>`（或设置环境变量 `DSHENV_OVERLAY=<name>`），否则会按 base 清单比对并报漂移。

## 4. 安全警告

**DSH Web 能让连接方执行 shell 命令。** 容器内 `cordis.patch.yml` 把 webserver 的 `host` 设为 `0.0.0.0`，这只是为了让 Docker 能把端口转发进容器。由此带来两道边界：

- **宿主机与局域网**：端口只发布到宿主机回环 `127.0.0.1:3080:3080`，局域网上的其他机器连不到。把发布改成 `3080:3080`、用 `docker run -P`（镜像有意不写 `EXPOSE`；一旦加上，`-P` 会把端口发布到宿主机所有接口的随机端口），或放到反向代理后对外公开，都会把远程代码执行能力暴露出去。
- **同一 Docker 网络内的容器**：回环发布挡不住它们。同网络的任何容器都能直接访问 `<容器 IP>:3080`，并且能通过 DSH 的 Host 校验（监听所有接口时 DSH 自动信任本容器的网卡 IP），此时唯一的防线是每次进程启动时生成的 token。直接 `docker run` 不指定网络时，默认 bridge 上的**所有**容器都属于这一类，因此应放到独立的自定义网络（如上面的 `dsh-net`）。`compose` 默认给每个项目建一个独立网络，已满足要求；但同一 compose 项目里再加的其他服务会共享这个网络，也能访问它。

`DEEPSEEK_API_KEY` 只能在 `docker run -e` / `docker compose` 的运行时环境变量里提供，不要写进 `ENV`、`ARG` 或构建参数，也不要提交进镜像。

没有提供 key 时，对话会以 `MISSING_CREDENTIAL` 结束，界面会引导你到 Web 的 Models 页录入 key。不要在那里录入：录入的 key 会存进容器内的 `$DSH_HOME`（不在会话数据卷里），容器重建即丢失，也让 key 留在容器文件系统中。应停掉容器，改用 `-e DEEPSEEK_API_KEY` 重新启动。

## 5. 数据

`compose.yaml` 把命名卷 `dsh-data` 挂载到 `/home/dsh/.dsh/sessions`，这是会话日志的权威存储路径；容器重建后会话记录会保留，可以用 `session/list` 等 API 找回。

不在卷中的部分：

- `$DSH_HOME/profiles`、`$DSH_HOME/envctl` 等插件环境来自镜像构建，不放进卷，这样每次重建镜像才能重新按清单收敛；卷不挂这些路径。
- `$DSH_HOME/storages/workspace.json`（Web UI 里的工作区列表）不持久化，容器重建后需要重新添加工作区；`storages/` 下的投影缓存本来就可以从会话日志重建。

如果直接 `docker run`（不用 compose、不挂卷），容器删除后会话数据也会一起丢失。

## 6. 限制

- 只支持 npm 与 git 插件源；镜像内不含 dshenv 之外的本地源码，local 源不可用。
- git 源插件必须在 `lock.json` 里固定 commit，否则 `plan` 会报 `blocked`；需要构建步骤的 git 插件要按 DSH 提示配置 `allowBuilds`。
- 改动 `envctl/manifest.yaml`（或 overlay）后要重新构建镜像；不要在运行中的容器里执行 `dshenv apply`，容器不持久化 envctl 状态。
- 未在 Docker Desktop（macOS/Windows）上验证过。

## 7. 已验证（2026-09-27）

以下内容已用真实 Docker 构建和运行验证，详见任务报告：

- 用 scratch 配置仓库（`envctl/manifest.yaml` 声明 profile `web`、npm 插件 `@nanmicoder/dsh-agent-teams@0.1.21`）构建镜像成功；构建期 `dshenv apply --yes` 安装成功、`dshenv plan` 退出 0；容器内 `dshenv plan` 同样退出 0。
- 镜像内 `dsh --version` 为 `0.1.7-rc.2`；`dump-config` 中 webserver 行为 `host: 0.0.0.0`、`port: 3080`。
- 端口只发布到 `127.0.0.1` 时，宿主机非回环 IP 无法连接；带外部 `Host` 头访问 `/api` 会被拒绝（403）；但 `Host` 为容器网络地址（如 `172.17.0.5:3080`）时通过了 Host 校验，只因缺 token 返回 401，印证了第 4 节同网络容器的风险。
- **首次访问需要启动 token**：DSH Web 没有匿名访问，任何没有 token 的请求都会返回 401；启动 token 打印在 `docker logs <容器名>`（或 `docker compose logs dsh`）里，形如 `http://127.0.0.1:3080/?token=...`，第一次必须打开这个链接完成认证。因此用 `curl -f` 做就绪轮询永远不会成功，只能按“有 HTTP 响应（包括 401）”判断服务已启动。
- 挂载 `dsh-data` 卷后，`compose down`（不带 `-v`）再 `up` 重建容器，会话日志与 `session/list` 结果保留；`storages/workspace.json` 按预期不保留；插件环境（`profiles/`、`envctl/`）来自镜像，不受卷影响。

真实对话（2026-09-27）：运行时以 `-e DEEPSEEK_API_KEY` 传入 key，通过 DSH Web 的 `/api`（与 Web UI 相同的 HTTP 接口：登录、`session/create`、`session/prompt`、`session/page`）发送一条消息，模型正常回复；Web UI 的流式通道（WebSocket `/api/remote.mux` 上的 `session/follow`）也验证过，回复以多个 `text-delta` 帧陆续推送到达，拼接结果与最终保存的回复一致；不带 key 的对照容器以 `MISSING_CREDENTIAL` 结束。key 只在运行时传入，镜像历史与容器内 `$DSH_HOME` 中都查不到。

端口发布：验证用的是 `127.0.0.1:13080:3080`（本机 3080 被占用），与默认的 `127.0.0.1:3080:3080` 只差宿主机端口号，视为已覆盖。

未验证：Docker Desktop（macOS/Windows）。
