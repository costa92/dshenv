# dshenv 后续规划与路线图

---

## 阶段规划

### Phase 1: 只读原型（0.1.0，已验证）
- [x] CLI 骨架与环境路径解析
- [x] 声明式清单 (`manifest.yaml`)、锁 (`lock.json`) 与状态格式及校验
- [x] 安全 DSH 运行时能力探测 (`doctor`)
- [x] 只读 Profile 盘点 (`inventory`)
- [x] 无损环境捕获 (`capture`)
- [x] 确定性变更比对与状态映射 (`plan`, `status`)

验证基线：13 个测试文件、62 项测试通过；`typecheck` 通过；隔离 `doctor` 能识别 DSH `0.1.7-rc.2`，并保持 `mutations=false`。

### Phase 2A：只读能力基础设施（已验证）
- [x] 精确识别已验证的 DSH `0.1.7` 版本族，拒绝 `0.1.70` 等相似版本
- [x] 放行 DSH `0.2.0` 版本族（2026-10-08）：npm `0.2.0-rc.2` 冒烟 13 步全部通过；模板 peer 范围放宽到 `<0.3.0-0`
- [x] 放行 DSH `0.2.1` 版本族（2026-10-08）：冒烟改用 DSH 官方 bundle 后，`0.2.1-alpha.1` 不带豁免 13 步全部通过；模板 peer 范围加上 `>=0.2.1-0` 一段，`0.2.1-alpha.1` 这类预发布版也能匹配
- [x] 只读探测官方 operations export 的声明与目标文件，不执行插件管理器代码
- [x] 建立细粒度能力矩阵与单向收紧的证据评估
- [x] `doctor` 增加能力状态，并保留原有 JSON 字段与 `mutations=false`

验证记录（2026-09-25）：Node `v25.2.1`、pnpm `10.24.0`；`pnpm test` 为 16 个文件、102 项测试通过，`pnpm typecheck`、`pnpm build` 与 `git diff --check` 通过。隔离真实源码 `doctor` 识别 DSH `0.1.7-rc.2`：`discovery` 和 `packageOperations` 为 `available`，`bundleSelection` 和 `entryToggle` 为 `requires-live-service`，`environmentMutation` 为 `disabled`，`mutationsSupported=false`。全局命令用相同隔离参数验证；fixture 不产生 `envctl`，Harness 仓库不变。

### Phase 2B：官方管理器适配与环境接管（已实现）
- [x] 确立所有权 Schema（`ownership` 字典记录 `adoptedAt`、`adoptedBy` 与 `lockedVersion`）
- [x] 实现 `adopt --from <candidate>` 命令：校验候选事实一致性，生成所有权记录
- [x] 实现独占写锁（`acquireEnvironmentLock`）、快照备份（`backups/`）与操作日志（`logs/journal.jsonl`）
- [x] 正式 `apply` 先加锁再读取清单、盘点与计划，避免 rollback/purge 间隙导致执行过期计划；`--dry-run` 不加锁
- [x] 锁被占用时每 100ms 重试直至 `timeoutMs`（默认 5 秒）；无法解析的锁文件超过 5 秒才视为陈旧，避免抢走正在写入的锁
- [x] 陈旧锁接管经 `mkdir` 守卫串行化，并发等待方不会同时接管；守卫残留时报错提示手工删除，不自动回收
- [x] 实现 `apply` 状态机执行器（支持 `--dry-run`、能力检查与异常自动快照回滚）
- [x] `apply` 通过 DSH CLI 执行 `install/update`，执行后复盘；正式 apply 需要 `--yes`
- [x] `apply` 按 `dsh.profile.bundles` 执行 `enable/disable`（禁用保留依赖）
- [x] 受管插件 `remove`：仅 `state.ownership` 中且已离开清单的包，先改 bundles 再 `dsh plugin remove`
- [x] `configure`：digest 不一致时写入 `cordis.patch.yml` 受管块
- [x] 同一插件的多项差异一次列全（install/update → enable/disable → configure），单次 `apply` 即可收敛
- [x] 全量测试套件覆盖率（21 个测试文件，163 项测试全部通过）

### Phase 3: 受管 Git、Patch 管理器与便捷 CLI 命令（已实现）
- [x] 受管 Git 插件自动化 clone / fetch / fast-forward 校验 (`src/source/git.ts`)
- [x] 脏工作树安全拒绝保护（防用户本地代码丢失）
- [x] 本地源码目录构建审批与递归 SHA256 digest 校验机制 (`src/source/local.ts`)
- [x] apply 成功后把本地来源源码 digest 写入 lock；plan 在 digest 变化或未记录时对已装本地插件 `update`
- [x] 受管 YAML Patch 块插入、提取、校验与移除适配器 (`src/patch/patch.ts`)
- [x] 便捷插件管理命令：`install`、`update --to`、`enable`、`disable`、`remove`、`list`、`config get|validate|set`、`source status|clone|pull` (`src/commands/plugins.ts`、`src/commands/source.ts`)
- [x] `source clone --profile` 写入 `envctl/sources` 并锁定 commit，plan/apply 可安装 git 插件
- [x] `source pull --profile` 更新 lock commit；apply 成功后标记 `restart-required`
- [x] 标记 `restart-required` 时写入复盘得到的 `installedVersion`，不再丢弃该字段
- [x] plan 比对 Profile 依赖 spec 的 `#<commit>` 与 lock commit，不一致时 `update` 重装锁定 commit（无 commit 证据不猜）
- [x] 全量测试套件覆盖（当前 36 个测试文件，234 项测试全部通过）

### Phase 4: 事务日志、回滚与垃圾清理（已实现）
- [x] 操作日志写入 `journal.jsonl`（apply/rollback/gc）
- [x] `rollback`：从 `envctl/backups/` 恢复管理文件；需要 `--yes`；不撤销 DSH 包变更
- [x] `gc`：只删除 `envctl/trash` 内过期项；需要 `--yes`
- [x] apply 执行失败时恢复管理文件快照
- [x] apply 执行失败时逆序撤销本工具对 Profile bundles（保留原位置）与 `cordis.patch.yml` 的改动；DSH 已完成的卸载不回滚
- [x] `purge`：有 ownership 的受管 patch（及 `envctl/sources` clone）移入 trash；外部路径拒绝

### Phase 5：Base + Overlay 清单合并（已实现）
- [x] `envctl/overlays/<name>.yaml` 叠加 base，按别名/patch id 合并，支持新增、字段覆盖、`remove: true`、`environment` 覆盖
- [x] 本机持久选择（`overlay use`），`--overlay` / `--no-overlay` / `DSHENV_OVERLAY` 临时覆盖；缺失即报错，不退回 base
- [x] 出处：`list` 的 `origin`、`overlay show`
- [x] 有生效 overlay 时写入命令必须指定 `--layer`
- [x] apply 在锁内加载合并清单，state 记录 `appliedOverlay`，切换时警告
- [x] lock 只细化合并清单：npm 目标版本以清单为准，git url 不一致时不沿用 lock commit；`--layer base` 写入（含 `adopt`、`source clone`）前校验与 overlay 可合并
- [x] npm 版本只允许精确版本（schema、`install`、`update --to`、`capture`），避免范围与已装版本永远不一致
- [x] git 清单声明的 `commit` 与 lock 缺失或不一致时 `blocked` 并给出处理指引，不再静默以 lock 为准
- [x] 选了 overlay 但 base 清单不存在时 `doctor` 照常出报告（`manifestExists: false`），overlay 文件仍单独校验
- [x] 全量测试套件覆盖（当前 58 个测试文件，417 项测试全部通过）

### 审查修复（2026-09-26 第二轮）
- [x] A 批（数据安全）：`purge` 拒绝移走有未提交改动的受管克隆；包名不得以 `.` 开头；每次写 base 清单前做 schema 校验；`adopt` 遇到不可读的现有文件报错而不覆盖，并沿用清单已有别名
- [x] B 批（配置 patch）：同插件多个 patch 各占一块并整体收敛；`enabled: false` 与删掉的 patch 会被清除；写入不再展开 `$` 模式；别名按字面匹配且不得含空白；删除块不再压缩块外空行
- [x] C 批（收敛）：in-box 插件不在 bundles 视为禁用；来源类型切换触发重装；无变更的 apply 也记录当前 overlay，`adopt` 保留该记录（禁用插件升级、capture 本地 digest 两条经核对为预期行为，不改）
- [x] D 批（按用户选定方案）：新增 `restarted` 清除 `restart-required`；拒绝带凭据的 git URL；所有写管理文件的命令加环境锁；rollback 先存当前文件快照再原子恢复；原子写经软链接写目标并保留权限；本地目录与 source clone 取 `package.json` 包名、git URL 支持 `--package`；重复 install / source clone 只替换来源
- [x] 低优先级：`__proto__`/`constructor`/`prototype` 不得作 profile 名或别名；plan 不再显示 `-> latest`、`? -> ?`；README 更正 `adopt --yes`；其他用户进程持有的锁（EPERM）不再被当作失效

### GitHub Actions（已实现）
- [x] 仓库 CI：`.github/workflows/ci.yml` 在 Node 22/24 上以 frozen lockfile 跑 typecheck、test、build
- [x] 使用者示例：`docs/examples/github-actions/dshenv-check.yml`，`validate` 校验 base 与每个 overlay，`drift` 在 self-hosted runner 上以 `plan` 退出码做漂移门禁；测试会实际执行两段脚本

### 组件脚手架（`dshenv new`）（已实现）
- [x] `dshenv new <skill|agent|tool|mcp> <name>` 从 `templates/` 下的文件模板经 `{{key}}` 替换生成组件包；`--dir`、`--package`、`--typescript`（仅 tool）、`--loose`（仅 skill）
- [x] skill 默认生成 bundle（额外一行 `dsh-skill-filesystem` 挂载 `skills/`），`--loose` 直接写 `$DSH_HOME/skills/<name>/SKILL.md`，由 DSH 自动发现，不进清单
- [x] agent 生成 `dsh-agent-preset` + `dsh-persona`；tool 生成纯 JS `defineTool` 插件，peer 依赖 `@deepseek-ai/dsh-tools` 从运行中的 DSH 解析；mcp 生成 `dsh-mcp-client`
- [x] `-p` 复用 `install` 命令抽出的 `installPlugin`，登记失败时清理生成的目录，不自动 `apply`
- [x] 模板 peer 范围要求 DSH `>=0.1.7-0 <0.2.0-0`（agent 预设与 linked-package peer 解析在更早版本缺失）
- [x] 真实 DSH 冒烟验证（2026-09-26）：源码构建 0.1.7-rc.1 跑 `dsh web`，四类生成包全部加载成功（skill 列出、agent 预设注册、tool 注册且包内无 `node_modules`、mcp 仅因无服务端连接失败但无 schema 错误）；已安装的全局 0.1.5-rc.2 无法运行这些模板
- [x] npm 安装版冒烟验证（2026-09-26）：`@deepseek-ai/dsh@0.1.7-rc.2` 本地安装后跑 `dsh web`，skill、agent、JS tool 均加载；`--typescript` tool 经 `pnpm install && pnpm build` 后在 npm 版与源码版 0.1.7-rc.1 上均注册并可调用，`dsh-tools` 解析到运行中 DSH 的副本而非包内副本；mcp 行已激活并向配置地址发起连接（无真实 MCP 服务端，未注册工具）
- [x] 终审修复：模板中 `{{name}}` 标量加引号（`123`、`true` 等名称不再被 YAML 解析为非字符串）；`--dir` 为非目录或符号链接时报错且不删除；失败清理包括本次新建的父目录
- [x] 全量测试套件覆盖（当前 62 个测试文件，467 项测试全部通过）

### 容器示例（已实现）
- [x] `docs/examples/container/{Dockerfile,cordis.patch.yml,compose.yaml}`：镜像构建期把当前 dshenv 源码打包安装并 `COPY` 配置仓库的 `envctl/`，`dshenv apply --yes`、`dshenv plan` 校验无漂移后再 `dsh web`
- [x] home 级 `cordis.patch.yml` 把 webserver 监听改为 `0.0.0.0`（供 Docker 转发），CLI 本身拒绝 `--host`；端口只发布到 `127.0.0.1:3080:3080`（挡住局域网），不 `EXPOSE`、不传 `--trusted-host`；同一 Docker 网络内的容器仍可经容器 IP 访问、只剩启动 token 防护，文档建议使用独立网络
- [x] 命名构建上下文传入 dshenv 源码（当时尚未发布到 npm；现在只用已发布版本时检出对应 tag 即可）；DSH 版本固定 `0.1.7-rc.2`
- [x] 会话日志挂载命名卷 `dsh-data:/home/dsh/.dsh/sessions`，`profiles/`、`envctl/` 仍来自镜像不进卷
- [x] 真实 Docker 构建验证（2026-09-27）：scratch 配置仓库 apply/plan 通过，端口只回环可达、外部 Host 头访问 `/api` 被拒，容器重建后会话数据经卷保留、`storages/workspace.json` 按预期不保留
- [x] 真实对话验证（2026-09-27）：运行时 `-e DEEPSEEK_API_KEY` 传入 key，经 DSH Web `/api` 发送消息得到模型回复；无 key 时以 `MISSING_CREDENTIAL` 结束；镜像历史与容器 `$DSH_HOME` 中无 key
- [x] 流式通道验证（2026-09-27）：WebSocket `/api/remote.mux` 上 `session/follow`（`assistantStream: true`）收到 32 个 `text-delta` 帧，约 217 ms 内陆续到达且早于 `turn/end`，拼接文本与保存的回复一致

### 远程分发：团队共享基线（已实现）
- [x] `dshenv remote add/show/remove` 与 `dshenv sync`：订阅团队 Git 配置仓库（裸克隆于 `envctl/remote/repo.git`），采用 `<path>/manifest.yaml`、`lock.json`、`overlays/*.yaml`，固定到明确 commit 并记录于 `envctl/remote.json`（文件与 lock 条目的 sha256 摘要）
- [x] lock 按 `profile/alias` 条目归属：同步时只替换团队条目，本地 overlay 插件的 Git commit 与本地源摘要保留；团队 lock 不得含本机源条目
- [x] 预览（退出码 2）展示文件与 lock 条目的增删改及接受后的 plan；`--yes` 接受，只接受 fast-forward；`--ref` 限于订阅分支；接受后不自动 `apply`
- [x] 远程内容只读：写 base / 远程 overlay / 团队 lock 条目的命令一律拒绝，本机定制写本地 overlay；本地改动需 `--discard-local-changes` 才能覆盖，同名本地文件或条目需 `remote add --replace`
- [x] 快照与恢复覆盖 `remote.json` 与远程 overlay，`dshenv rollback` 可撤销 `sync`，中途写入失败自动恢复
- [x] `doctor` 报告订阅 URL、固定 commit 与被改动的远程文件和 lock 条目
- [x] 真实端到端验证（2026-09-27）：6 个手动验证步骤（订阅预览与接受、本机定制与写保护、团队更新的预览/接受/plan/`apply --dry-run`、快照回滚后再同步、本地改动冲突与 `--discard-local-changes`、凭据 URL 与历史改写拒绝）全部符合预期，未发现缺陷；并发文件锁另行验证（见下条）
- [x] 真实 apply 补测（2026-09-27）：npm 版 DSH `0.1.7-rc.2`、隔离 `DSH_HOME`，团队仓库固定真实 npm 插件 `@nanmicoder/dsh-agent-teams@0.1.21`；订阅后 `apply --yes` 真实安装、`dsh --dump-config` 可见插件层、`plan` 退出 0、`doctor` 无本地改动；本地 overlay 不影响 `sync`；团队禁用插件后 `sync --yes` + `apply --yes` 生效；`rollback <sync 快照 id> --yes` 回到首个状态后再次 fast-forward，未发现缺陷
- [x] 并发验证（2026-09-27）：团队提交更新后同时启动 3 个 `sync --yes` 进程，全部退出 0；恰好 1 个接受（固定到新 commit），另 2 个等锁后报已是最新；日志只有 1 条新的 `sync-completed`、只多 1 个快照，`remote show` 无本地改动，锁文件已释放
- [x] 全量测试套件覆盖（当前 75 个测试文件，600 项测试全部通过）

### 感知热加载的 apply（已实现）
- [x] `apply`（含 `--dry-run`）对每个有操作的 Profile 运行一次 `dsh --profile <p> --dump-config`（超时 15 秒），按 `hmr` 行判断热加载 `on` / `off` / `unknown`；Profile 尚未创建时不探测
- [x] 热加载开启时 install、enable、disable、configure、remove 无需重启（state 记 `healthy`，remove 删除条目）；update 一律需要重启；关闭或无法判断时与原先一致，全部 `restart-required`
- [x] 文本输出 `No restart needed:` / `Restart DSH to load:` 分组与 `Then run: dshenv restarted`；`--json` 新增 `restart` 字段；`--dry-run` 逐项标注；`plan` 不变
- [x] 改写 Profile `package.json` 时持有与 DSH 兼容的 `package.json.lock`（`wx` 创建、内容 `<pid>\n`、权限 0600，指数退避最多等 30 秒，不删除他人的锁）
- [x] 热加载开启时 remove 先移出 bundle、等待 3 秒再调用 `dsh plugin remove`（插件不在 bundle 列表中时不等待）
- [x] 失败回滚 `cordis.patch.yml` 时，DSH 在 dshenv 写入后改过该文件则只恢复该插件的受管块，不覆盖 DSH 的改动
- [x] 真实验证（npm 版 DSH `0.1.7-rc.2`、隔离 `DSH_HOME`、端口 13181）：install / disable / enable / remove 后插件管理器 `listPlugins` 当场反映变化且无需重启；本地源码变化触发的 update 输出需要重启；home 级 patch 关闭 hmr 后改动全部需要重启
- [x] configure 真实验证（端口 13182）：用 `dshenv new tool` 生成的本地插件在每次重组时记录配置值，`apply --yes` 改配置后数秒内运行中的 DSH（进程号不变）打出新值，输出列在 `No restart needed:`，dry-run 标注 `(no restart)`
- [x] 修复新建 Profile 的 `cordis.patch.yml`（DSH 生成的 `[]`）首次 configure 时追加出第二个 YAML 文档导致 DSH 拒绝解析；最后一个受管块移除后若只剩注释则写回 `[]`
- [x] 写 Profile 的 `cordis.patch.yml` 时同样持有 `package.json.lock`（DSH 插件管理器改该文件时持同一把锁）；有 blocked 操作的正式 apply 先报错再探测；多个 Profile 并行探测

## 运行时加载核对（已实现）

- [x] `dshenv runtime` 经 `DSHENV_DSH_URL` 登录运行中的 `dsh web`，用 Plugin Manager 的 `listBundles` 与 `listPlugins` 核对清单插件是否已加载或卸下
- [x] token 与 cookie 不出现在输出与错误中；默认只连回环地址
- [x] 跳过被配置停用的行与其他已选中 bundle 共享的行；按安装包集合核对运行中的 DSH 是否为该 profile
- [ ] 核对内存中加载的版本（DSH 未暴露）

## 错误输出、Git 安装与版本冒烟（已实现）

- [x] 带 `--json` 时错误以 `{"error":{"type","message","exitCode"}}` 写入 stderr；解析前抛出的错误按 `--` 之前的 argv 判断；commander 参数错误同样以 JSON 输出
- [x] `prepare` 构建 `lib/`，支持从 Git 地址安装：`pnpm add -g --allow-build=@costa92/dshenv "git+https://github.com/costa92/dshenv.git#<ref>"`；隔离 `PNPM_HOME` 实测全局安装可运行。npm 从 Git 地址安装在准备阶段崩溃（npm 10.9 arborist），只支持 pnpm；推荐改用 npm 包（见「发布与分发」）
- [x] `make smoke-dsh DSH_VERSION=<v>`：临时目录安装 npm 版 DSH，隔离 `DSH_HOME` 下跑 doctor、install/disable/remove 的 apply 与 plan；门禁拒绝时带 `--allow-untested-dsh` 继续。放宽门禁的步骤见 [`DSH版本升级.md`](DSH版本升级.md)
- [x] 真实冒烟（2026-09-27）：`0.1.7-rc.2` 13 步全部通过；`0.1.6-alpha.2` 被门禁拒绝，带覆盖参数全部通过。npm 上尚无更新的版本
- [x] 全量测试套件覆盖（当时 89 个测试文件，798 项测试全部通过）

## 发布与分发（已实现）

- [x] 开源：MIT 许可证；GitHub 仓库 [`costa92/dshenv`](https://github.com/costa92/dshenv)（2026-09-28 由 `costa92/dsh-envctl` 改名，与 npm 包名一致，旧地址自动跳转）
- [x] 版本号只取 `package.json`（`dshenv --version` 读取它）；变更记录见 [`CHANGELOG.md`](../CHANGELOG.md)
- [x] 推送 `v*` tag 触发 `.github/workflows/release.yml`：核对 tag 与版本、从 CHANGELOG 取发布说明、跑与 CI 相同的检查、`pnpm pack` 后把同一份 `.tgz` 发布到 npm（带 provenance）并附在 GitHub Release 上。步骤见 [`发布流程.md`](发布流程.md)
- [x] npm 包 [`@costa92/dshenv`](https://www.npmjs.com/package/@costa92/dshenv)：`npm install -g @costa92/dshenv`，命令名 `dshenv`。无作用域的 `dshenv` 被 npm 以与 dotenv、osenv 过于相似为由拒绝
- [x] 已发布：0.1.0（首个公开版本，仅 GitHub Release）、0.1.1（首次发布到 npm）、0.1.2（容器端到端测试发现的修复）、0.1.3（仓库改名后的元数据）、0.2.0（审查修复与 schema 收紧）、0.2.1（`self-update`）、0.3.0（DSH 配置双向同步、`tools`、`install in-box:`）、0.3.1（`web start|stop|status`、`runtime --start` 与 2026-09-29 审查修复），各版本内容见 CHANGELOG
- [x] 改用 npm Trusted Publishing：0.3.0 起经 OIDC 发布（npm ≥ 11.5.1、自动 provenance），失败时才用备用的 `NPM_TOKEN`；手动运行 Release 工作流可在不发布的情况下检查两种方式，见 [`发布流程.md`](发布流程.md#npm-trusted-publishing)

## 容器端到端测试与修复（已实现）

- [x] 干净容器（`node:22-slim`，非 root）从 npm 安装 dshenv 与 DSH `0.1.7-rc.2`，覆盖当时全部 24 个顶层命令（`rollback`、`purge` 只做 dry-run）共 107 项检查：npm 插件完整生命周期与配置、overlay、capture/adopt、四类脚手架与本地来源漂移、Git 来源 clone/pull、rollback/gc/purge、对运行中 `dsh web` 的 `runtime`、团队远程订阅与同步
- [x] 首次运行（0.1.1）发现并修复：Git 来源缺少 `git+` 前缀导致 `file://` 等地址安装失败；DSH 插件命令失败时只剩退出码（改为显示 DSH 自己的 `dsh:` 诊断行，不显示 pnpm 原始输出）；`adopt` 替换已有插件时丢失已声明的 `patches`；`status <插件>` 不认别名；`source pull --ref <分支名>` 快进到本地分支自身而没有更新
- [x] Codex 审查上述修复，指出 `source pull` 会把 `HEAD`、`HEAD~1` 等修订改写为上游引用；改为只对与上游分支完全同名的 ref 跟随 `origin/<ref>`，复审无问题
- [x] 0.1.2、0.1.3 发布后以 npm 安装包重跑，107 项全部通过
- [x] 主链端到端测试收进仓库：`scripts/e2e-dsh.sh`（`make e2e-dsh`，收进时 123 项，现为 148 项，新增 `runtime --start` 与 `web start/stop/status`：DSH 自装插件的 capture/adopt 与所有权、本地来源安装与源码变更更新、配置补丁、版本漂移修复、对 `dsh web` 的 `runtime`、rollback、受管卸载；skill/agent/mcp 脚手架与 loose skill；Git 来源 clone、pull 与锁定提交；overlay 独有插件的安装与随 overlay 移除；purge 与 gc；profile patches 与 loose skill 的 pull 与 apply 双向同步；独立 `DSH_HOME` 中的团队远程订阅、sync、拒绝本地改动与改写历史），由 `.github/workflows/e2e.yml` 在 PR 与 master 上对已验证的 DSH 运行，与 Vitest CI 分层、自 2026-09-30 起是 master 的必需检查
- [x] DSH 兼容性矩阵：`.github/workflows/compat.yml` 每天与 master 推送时对 DSH `0.1.7-rc.2`（必须通过）、`latest`、`next`（仅报告）运行 `scripts/smoke-dsh.sh`，可手动指定额外版本
- [x] 容器检查中的 overlay、Git 来源、四类脚手架、gc/purge、团队远程同步已并入 `e2e-dsh.sh`；DSH 的 pnpm 卸载 `link:` 依赖后会在 `node_modules` 留下符号链接，脚本以 profile 的 `package.json` 判断是否已卸下

## DSH 配置双向同步（已实现）

- [x] 清单 `profiles.<profile>.patches` 原样保存 cordis patch 条目（`id`/`name`/`config`/`disabled`/`insert`，`!!js` 记作 `{ __jsExpr }`）；overlay 按 id 替换、`{ id, remove: true }` 删除、新 id 追加；别名 `@profile` 保留给 Profile 受管块
- [x] `apply` 把条目写进一个 Profile 受管块，与插件块同一把 `package.json.lock`，失败时按块撤销；Profile 不存在时等同一次 apply 的安装建好后再写，否则 blocked
- [x] `plan` 报告受管块之外的条目（不计入变更），区分受管块在 DSH 里被改过与清单改过
- [x] `dshenv pull`：按 DSH 的组合语义（后写的同 id 条目逐键覆盖）合并，本机绝对路径进本机 overlay（缺省新建并选中 `local`），团队 remote 拥有基础清单时全部进 overlay；两边都改过需 `--prefer`；快照可回滚，回滚删除 pull 新建的 overlay 时一并清除其选择
- [x] `adopt` 接管 Profile 时执行同样的收取，`capture` 提示受管块之外的条目
- [x] DSH 0.1.7 的 `dsh.profile` 只有 `bundles`（`patchReload` 仅 0.1.5 有），不另行同步
- [x] 真实端到端：`e2e-dsh.sh` 在 DSH `0.1.7-rc.2` 上覆盖 DSH 写入条目 → `pull` → `dump-config` 可见 → DSH 改块 → `pull` → `apply` 覆盖 DSH 改动
- [x] `~/.dsh/skills` 下的 loose skill 同步：`envctl/skills/<名字>` 为声明，`state.skills` 记录两边最后一致时的摘要，据此分辨改动方向；`apply` 复制并把旧副本移进 trash，`pull` 反向；快照带标记保存 `envctl/skills`（旧快照不动该目录）；团队 remote 的文件键扩展到 `skills/<名字>/...`，团队技能不可由 pull 改写
- [x] 真实端到端：`e2e-dsh.sh` 覆盖 loose skill 的 pull、清单改动后 apply、DSH 改动后 pull，以及团队仓库技能随 sync 与 apply 装进 DSH（当时共 123 项）

## 自我升级、内置工具与后台 dsh web（已实现）

- [x] `dshenv self-update`：查询 npm 上的版本，用安装 dshenv 的包管理器（全局 npm 或 pnpm）升级或 `--to` 回退；本地链接、源码检出与 Git 安装不替换（0.2.1）
- [x] `dshenv tools list|enable|disable|config`：按架构图分类读出 Profile 内置工具，开关与配置写进 profile patches；agent 预设内的工具整份固定预设，`plan` 列出（0.3.0）
- [x] `dshenv runtime --start`：临时启动 `dsh --profile <p> --no-open --port 0` 核对后停止，Ctrl+C 时也停干净
- [x] `dshenv web start|stop|status`：后台 dsh web，地址与 pid 记在 `envctl/run/<profile>.json`（0600），按主进程启动时间识别、不误停复用的 pid，区分 `leftover`/`unknown`，同一 Profile 串行；`runtime` 未设 `DSHENV_DSH_URL` 时自动使用

## 全项目审查修复（2026-09-29）

- [x] 进程：源码方式（`pnpm --silent --dir <src> dsh`）下 `--version`/`--dump-config` 超时会结束整棵进程树；强制结束只针对仍存活的进程
- [x] apply：失败只恢复 `lock.json`/`state.json`；每装成功一个插件即记入所有权；rollback 保留仍安装插件的所有权；同一 Profile 先卸后装；只在 bundle 列表中的包按声明来源安装；尊重清单 `allowUntestedVersion`；不存在的 Profile 中的 in-box 操作在 plan 阶段 blocked
- [x] adopt 的 alias 冲突改用新 alias；`gc --older-than` 只接受非负数；purge、`source clone`、`source pull` 的失败路径不再留下半写状态
- [x] 安全：团队配置不能设置 `environment.harness.sourceDir`/`sourceRoot` 或引用本机 Git 地址；Profile 名、Git 地址、ref、commit 统一校验；`self-update` 在主目录运行；`remote sync` 预览不跟随软链接；`--allow-remote` 只接受 https
- [x] CI：Release 拆成只读的 build 与只下载 tarball 的 publish，打包后先安装冒烟；action 固定 SHA、checkout 不保留凭据；CI 增加 Windows 与 macOS（`check-os`）
- [x] 全量测试套件覆盖（当前 109 个测试文件，1068 项测试全部通过；e2e 148 项）

## 数据目录外置（已合并，PR #149）
- [x] `--envctl-dir` / `DSHENV_HOME` 指定 dshenv 数据目录，默认仍为 `<DSH 主目录>/envctl`，不改 DSH
- [x] 数据目录本身及其任何顶层条目不允许软链接，退出码 3 并提示迁移
- [x] `doctor` 注明数据目录来自 `--envctl-dir`、`DSHENV_HOME` 还是默认位置
- [x] 单个 skill 目录允许软链接（快照按内容保存，PR #148）
- [x] `dshenv migrate --to <dir>`：复制、核对后改名；改写清单、overlay、lock 与快照中的旧路径；锁内先写墓碑文件 `dshenv.moved` 再清空旧目录；软链接按内容复制，链接与目标保留
- 文档：[设计文档](design/2026-10-08-设计文档.md)

## DSH 配置体系对齐
- [x] 全局补丁 `$DSH_HOME/cordis.patch.yml`：清单与 overlay 顶层 `patches`，plan / apply / pull / 团队 remote 全链路；覆盖检测
- [x] 门禁放行 DSH 0.2.0 版本族，模板 peer 范围与 compat 矩阵同步
- [x] `insert` 行的相对插件名算作本机路径
- [x] 退役 bundle：`plan` 警告并给出 `remove` 命令
- [x] 放行 DSH 0.2.1：冒烟改用官方 bundle，不再等第三方插件的 peer 范围
- [x] DSH 官方 bundle：`plugins official` 列出当前 DSH 自带的官方 bundle；模板 Profile 不存在时 `apply` 让 DSH 按模板创建，`in-box` bundle 不再被挡
- [x] 应用前用 `dsh --dump-config` 在临时 DSH 主目录副本里校验补丁 id；新增 id 匹配不到时 `apply --yes` 中止
- [x] 报告 DSH 跳过的 bundle（`status` / `doctor`）；全局补丁改动的重启提示；`status` 展示 `compatibility.json` 的版本豁免
- [x] 放宽 `${...}` 限制（DSH 不做插值）
- [x] 全局补丁覆盖警告按字段比较，`-p` 下也提示，单独点出全局写的 `disabled`
- 文档：[设计文档](design/2026-10-08-设计文档.md)、[DSH 配置参考](design/2026-10-08-DSH配置参考.md)

## 架构缺口
- [x] 明文密钥检查（Secret Guard）：`pull` 不收含明文密钥的补丁，写清单的命令拒绝，`plan` / `status` / `doctor` 警告，团队仓库拒绝；推荐 `*Env` 写法
- [x] ~~用 DSH schema 的 `credential-ref` 豁免引用字段~~：不做，DSH 里这类字段（`apiKeyEnv`、`secretEnv`）都以 `Env` 结尾，已按键名豁免
- [x] 指定位置的 Skill / Plugin：经核实已支持（DSH `customSkillDirs` 由 dshenv 经补丁管理；插件用 `local-link`），不新增功能
- [x] 冲突跳过：`pull --prefer skip`（退出码 6）
- 文档：[设计文档](design/2026-10-08-设计文档.md)；架构图：[dshenv-architecture.png](design/images/dshenv-architecture.png)

## 延后能力

下列项有价值，但引入独立的兼容或数据模型子系统，不进入近期阶段：

- 调用运行时内部 service（如 `ctx.dynamicCordisRunner`）。DSH 已自带热加载，dshenv 负责感知与协作（见「感知热加载的 apply」），并可用 `dshenv runtime` 核对运行时加载状态
- 热替换已装插件的版本：依赖 DSH，暂不可行（见下节调研结论），升级插件仍需重启 DSH
- 静态 Cordis Service DAG 分析：静态分析不可靠，暂不做（见下节调研结论）；运行时以 `dshenv runtime` 的 pending 说明代替
- GUI / TUI / 插件市场 / 主观发行版
- 自动重启非本工具启动的 DSH 进程
- Desktop 内嵌 Harness 管理

## 热替换插件版本调研（2026-09-27，结论：依赖 DSH）

用 npm 版 DSH `0.1.7-rc.2` 与一个加载时写出自身版本的探针插件实测：

- 插件保持选中时升级：不触发任何重载，运行中的仍是旧版本。
- 先取消选中、再重新选中：插件重新 `apply`，但模块执行时间戳不变，Node 的 ESM 缓存返回旧模块，磁盘上的新版本未被读取。
- 用 profile 补丁把 `hmr` 的 `root` 指向插件安装目录（`ignored` 清空）后升级或直接改文件：仍不触发重载。

原因：profile 以 pnpm `nodeLinker: hoisted` 安装，任何版本都位于同一个 `node_modules/<包名>` 路径，ESM 缓存按 URL 记忆且从不清除；DSH 插件管理器对已安装包的再次安装直接返回 `restart-required`（`packages/boot/plugin-manager/src/index.ts` 的 `installBundle`）。`dsh-hmr` 的 `partialReload` 会删除模块缓存后重新导入，但只作用于它监视到的已加载源文件。

结论：dshenv 无法在不修改 DSH 的前提下热替换版本，升级继续报「需要重启」。可向 DSH 提需求：插件管理器升级插件时清除该包的模块缓存并重新导入（`partialReload` 已有同类做法）。需求草稿见 [`docs/dsh-requests/`](dsh-requests/dsh-plugin-manager-requests.zh.md)。

## Service DAG 调研（2026-09-27，结论：静态分析不可靠）

扫描 npm 版 DSH `0.1.7-rc.2` 自带的 281 个包与第三方插件 `@nanmicoder/dsh-agent-teams`：

- `package.json` 没有服务端 service 元数据；`dsh.client.inject` 只是网页端的包级注入。
- 76 个包有字面量 `inject` 声明，另有 69 个包的 `inject` 在运行时计算；96 个包能读出字面量的服务名，17 个包动态注册服务（含 Cordis 核心与 loader）。被依赖的 53 个服务中有 10 个找不到字面量提供者（如 `loader`、`profileContext`、`remote.session`）。
- 插件还会在函数内部用 `ctx.inject([...], ...)`、`ctx.get(...)` 按需依赖（agent-teams 即如此），静态读不全。
- 一个包常含多个插件，是否启用由 profile 补丁与 `!!js` 条件决定，依赖应按插件行而非按包计算。

结论：静态 DAG 误报与漏报都多，不作为 `apply` 前的拦截。已做的替代：`dshenv runtime` 在插件处于 `pending`（Cordis 在注入的 service 齐备前保持该阶段）时说明 `plugin <moduleName> is waiting for services it injects`。根本解法需 DSH 在插件清单接口中暴露每个插件缺少的 service，可向 DSH 提需求。需求草稿见 [`docs/dsh-requests/`](dsh-requests/dsh-plugin-manager-requests.zh.md)。
