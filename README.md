<!-- generated-by: gsd-doc-writer -->

# dshenv

[![npm version](https://img.shields.io/npm/v/@costa92/dshenv.svg)](https://www.npmjs.com/package/@costa92/dshenv)
[![CI](https://github.com/costa92/dshenv/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/costa92/dshenv/actions/workflows/ci.yml)
[![Release](https://github.com/costa92/dshenv/actions/workflows/release.yml/badge.svg)](https://github.com/costa92/dshenv/releases)
[![GitHub release](https://img.shields.io/github/v/release/costa92/dshenv.svg)](https://github.com/costa92/dshenv/releases/latest)
[![Node.js](https://img.shields.io/node/v/@costa92/dshenv.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/costa92/dshenv/dev/typescript.svg)](https://www.typescriptlang.org/)
[![DSH](https://img.shields.io/badge/DSH-0.1.7-blue.svg)](docs/DSH版本升级.md)
[![Last commit](https://img.shields.io/github/last-commit/costa92/dshenv.svg)](https://github.com/costa92/dshenv/commits/master)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`dshenv` 是用于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的声明式环境与插件管理工具（Environment-as-Code layer）。

它构建在 DSH 官方插件管理器协议与能力之上，通过声明式清单（`manifest.yaml`）和精确锁文件（`lock.json`）管理多 Profile 的插件、精确版本与配置补丁。

当前提供环境探测、Profile 盘点、捕获与接管、声明式插件管理、差异比对、健康诊断，以及范围受限的实际应用能力。`apply` 通过 DSH CLI 执行 `install/update/remove`，通过 Profile `dsh.profile.bundles` 执行 `enable/disable`，并通过 `cordis.patch.yml` 受管块执行 `configure`。调用 DSH CLI 前会用与 `doctor` 相同的版本矩阵做门禁。`remove` 只卸载 `state.ownership` 中且已从清单删除的插件。

---

## 核心特性

- **审阅后应用**：`plan` 与 `apply --dry-run` 先展示影响；正式 `apply` 对 `install/update/remove` 调用 DSH CLI，并在执行后重新盘点确认收敛。
- **声明式漂移检测**：自动计算实际安装态与目标清单差异（`plan` / `status`）。
- **无损环境捕获与接管**：将现有 DSH Profile 盘点为可审阅的候选清单（`capture`），确认事实未过期后再建立所有权（`adopt`）。
- **多运行时与能力探测**：无缝支持源码运行模式（`--harness-source`）、环境变量（`DSH_CLI`）及全局 PATH 探测（`doctor`）。
- **结构化输出**：所有命令的成功结果均支持 `--json` 格式；带 `--json` 时错误以 `{"error":{"type","message","exitCode"}}` 写入 stderr，命令行参数解析错误（未知选项、缺参数）也一样。
- **DSH 配置双向同步**：你在 DSH 里改的设置（模型、语言、权限、技能目录等写进 `cordis.patch.yml` 的条目）由 `dshenv pull` 收进清单，含本机绝对路径的条目放进本机 overlay；`~/.dsh/skills` 下的 loose skill 收进 `envctl/skills`。`apply` 按清单写回，`plan` 能分辨改动来自 DSH 还是清单。
- **组件脚手架**：`dshenv new` 从模板生成 skill/agent/tool/mcp 组件包，可选直接登记进清单。
- **团队共享基线**：`dshenv remote add` 订阅团队 Git 配置仓库，`dshenv remote sync` 预览并显式接受固定 commit 的更新；远程文件与团队 lock 条目只读，本机定制写本地 overlay，其插件的 lock 条目照常由本机维护。

---

## 路径与解析优先级

Harness 主目录解析优先级：
1. CLI 参数 `--dsh-home <path>`
2. 环境变量 `DSH_HOME`（为空或只有空白时视为未设置，与 DSH 一致）
3. 默认用户主目录 `~/.dsh`

开头的 `~`、`~/`、`~\` 按 DSH 的规则展开为用户主目录（`.env`、Docker `ENV` 里的 `~` 不经 shell 展开）；其余相对路径先按当前工作目录转为绝对路径。盘点读取 Profile 的 `package.json`（`dsh.profile.bundles` + `dependencies`），不把 `node_modules` 中的传递依赖当成插件，也不跟随 Profile 外的 symlink 读取包元数据。

DSH 运行时命令解析优先级：
1. 命令行 `--harness-source <path>`（转换为 `pnpm --dir <sourceDir> dsh`）。相对路径按当前目录解析，目录不存在时以退出码 3 报错，不会改用其他 DSH
2. 环境变量 `DSH_CLI`（支持 JSON 数组或字面执行文件名，绝不进入 shell）
3. 清单中的 `environment.harness.sourceDir`（同样转换为 `pnpm --dir <sourceDir> dsh`），在本机不存在时继续往下找
4. 系统 `PATH` 中的 `dsh`

跨机器同步 `manifest.yaml` 与 `overlays/`；`state.json`、`overlay-selection.json` 只属于本机。`lock.json` 由本机维护，但订阅团队 remote 后，团队 lock 中的条目归远程、随 `sync` 更新（见第 20 节）。

---

## 安装与快速上手

### 从 npm 安装（推荐）

```bash
npm install -g @costa92/dshenv
# 或
pnpm add -g @costa92/dshenv
dshenv --version
```

npm 包已含构建好的 `lib/`，安装时不需要构建；固定版本用 `@costa92/dshenv@0.10.1`。各版本见 [Releases](https://github.com/costa92/dshenv/releases)（附同一份 `.tgz`），变更见 [CHANGELOG](CHANGELOG.md)。

### 从 Git 地址安装

```bash
pnpm add -g --allow-build=@costa92/dshenv "git+https://github.com/costa92/dshenv.git#v0.10.1"
```

`#` 后可换成其他 tag、commit 或 `master`（未发布的最新代码）。安装时 pnpm 会在克隆中执行 `prepare` 构建 `lib/`；pnpm 10 默认不运行依赖的构建脚本，所以必须带 `--allow-build=@costa92/dshenv`，否则安装后缺少 `lib/` 无法运行。npm 从 Git 地址安装时会在准备阶段崩溃（npm 10.9 arborist 缺陷），请使用 pnpm。

### 本地链接安装

```bash
cd /path/to/dshenv
pnpm install
pnpm build
pnpm link --global
```

验证安装：
```bash
dshenv --version
```

### 升级 dshenv

```bash
dshenv self-update --check     # 只查询：有新版本时退出码 2，已是最新时退出码 0
dshenv self-update             # 升级到 npm 上的最新版本
dshenv self-update --to 0.2.0  # 升级或回退（降级）到指定的精确版本
```

`self-update` 用 `npm view --prefer-online` 查询版本，再用安装 dshenv 的包管理器替换自身：全局 npm 安装执行 `npm install -g @costa92/dshenv@<版本> --prefer-online`，全局 pnpm 安装执行 `pnpm add -g @costa92/dshenv@<版本>`。安装过程的输出直接显示在终端（stderr），不设超时，因为中途打断可能留下装了一半的全局包。

- 不带 `--to` 时只会升级：本机版本高于 npm 上的最新版（如预发布版或本地构建）时报告 `newer-installed`，不做改动。回退必须用 `--to` 明确指定，输出会注明是降级。
- 本地链接或源码检出安装的 dshenv，以及用 pnpm 从 Git 地址安装的 dshenv，不会被替换为 npm 版本，命令以退出码 3 给出升级方法（如 `git pull && pnpm build`）。`--check` 对这类安装仍会报告，`method` 为 `null`。
- 失败时只显示错误码（如 `EACCES`、`ERR_PNPM_FETCH_401`），完整原因见上方包管理器自己的输出；`EACCES` 表示全局安装目录不可写。
- Windows 上 npm 会在 `dshenv.cmd` 运行期间覆盖它，升级成功后命令行可能多出一行批处理报错，可以忽略，用 `dshenv --version` 确认版本。

卸载：`npm uninstall -g @costa92/dshenv`（pnpm 安装的用 `pnpm remove -g @costa92/dshenv`）；`~/.dsh/envctl` 保留，不需要时手动删除。

也可以手动升级：`npm install -g @costa92/dshenv@latest --prefer-online`。刚发布的版本在本机 npm 缓存过期前可能报 `notarget`，加 `--prefer-online` 即可。升级前先看 [CHANGELOG](CHANGELOG.md) 中的「变更」，例如 0.2.0 起清单不再接受 npm 来源的 `registry` 字段，lock 中的 git `commit` 必须是十六进制 commit id。

完整流程、能力边界、agent-teams 示例和常见问题见 [中文使用教程](docs/使用教程.md)。

DSH 发布新版本时，用 `make smoke-dsh DSH_VERSION=<版本>` 验证兼容性，放宽版本门禁的步骤见 [DSH 新版本兼容验证](docs/DSH版本升级.md)。

发布新版本的步骤见 [发布流程](docs/发布流程.md)。

---

## 命令参考

插件命令也可以写在 `plugins` 下（`dshenv plugins install|update|remove|enable|disable|list|config`），与 `tools`、`web`、`source` 等命令组写法一致；`install`、`update`、`remove`、`enable`、`disable` 同时保留在顶层。旧命令名 `list`、`config`、`runtime`、`source pull` 仍可使用，但不再出现在帮助里，分别对应 `plugins list`、`plugins config`、`verify`、`source sync`。

### 选择 Profile（`-p`）

`-p, --profile <name>` 是 DSH Profile 的名字，即 `profiles/<name>/` 的目录名和清单 `profiles:` 下的键。所有命令用同一套规则：

- 作用于单个 Profile 的命令（`install`、`update`、`enable`、`disable`、`remove`、`purge`、`plugins config`、`tools`、`verify`、`web start`、`web stop`）：不写 `-p` 时取环境变量 `DSHENV_PROFILE`；两者都没有时以退出码 3 报错并列出可选的 Profile（清单声明的与 DSH 已创建的）。`verify`、`web start`、`web stop` 在清单只声明一个 Profile 时直接用它。
- 按 Profile 过滤的命令（`plugins list`、`plan`、`apply`、`status`、`pull`、`capture`、`overlay show`、`mark-restarted`、`web list`）：不写 `-p` 表示全部 Profile，`DSHENV_PROFILE` 对它们不生效；`-p` 写了清单没声明、DSH 也没创建的名字时以退出码 3 拒绝，不会把拼错的名字报成“已同步”。
- `source`、`new` 的 `-p` 表示把克隆或新建的包登记到该 Profile，不写就不登记。

- 写入命令（`install`、`new -p`、`source clone -p`）指定一个清单没声明、DSH 也没创建的 Profile 时，默认按拼写错误拒绝并给出相近的名字；确实要新建时加 `--new-profile`。
- 写入类命令用了 `DSHENV_PROFILE` 时，会在 stderr 提示 `Using profile 'web' from DSHENV_PROFILE`（`--json` 时不提示）；只读命令（`plugins config get`、`tools list`、`verify`、`web start` 等）不提示。

```bash
export DSHENV_PROFILE=web      # 之后 dshenv web start、dshenv verify 等可以省略 -p
dshenv disable agent-teams     # 等同于 dshenv disable agent-teams -p web
```

### 确认执行（`--yes`）

哪些命令要加 `--yes`，只看一条规则：

- **只改 envctl 声明（清单、overlay、lock）的命令直接写入**：`install`、`update`、`remove`、`enable`、`disable`、`plugins config set|unset`、`tools enable|disable|config set|unset|reset`、`overlay create|use`、`new -p`、`source clone -p`、`source sync -p`。它们不碰 DSH profile，改错了再改回来即可，DSH 要等 `apply --yes` 才变。
- **会改 DSH、批量接管或覆盖文件的命令要 `--yes`**：`apply`、`adopt`、`pull`、`rollback`、`gc`、`purge`、`remote add|sync|remove`。不加 `--yes` 时只预览、什么都不写；有待执行的内容时退出码为 2，并在 stderr 提示加 `--yes` 重跑，所以 CI 里可以直接用不带 `--yes` 的命令检查漂移。这些命令都接受 `--dry-run`：即使同时写了 `--yes` 也只预览（`self-update` 的 `--dry-run` 同 `--check`）。

`remove` 仍接受 `-y`（旧脚本兼容），但它只改清单，加不加都一样。

### 1. `dshenv doctor`
探测 DSH 运行时能力并检查环境就绪状态。

```bash
# 自动探测系统 DSH
dshenv doctor

# 指定 DSH 源码目录
dshenv doctor --harness-source "$HOME/code/dsh/deepseek-harness"

# 结构化 JSON 输出
dshenv doctor --json
```

`doctor --json` 在 `runtime.capabilities` 中逐项报告能力状态，并保留 `runtime.discoverySupported`、`runtime.mutationsSupported` 等兼容字段：

| 状态 | 含义 |
| :--- | :--- |
| `available` | 已知 DSH 版本支持该能力，且需要的本地证据已验证；仅表示该项能力可见。 |
| `requires-live-service` | 该能力依赖已连接并认证的 live manager service；当前阶段尚未建立其连接契约。 |
| `disabled` | 当前版本、探测证据或本工具的安全边界不允许使用该能力。 |

对已验证的 DSH `0.1.7-rc.2` 源码，`discovery` 与 `packageOperations` 为 `available`，`bundleSelection` 与 `entryToggle` 为 `requires-live-service`，`configurationValidation` 与 `environmentMutation` 为 `disabled`。`packageOperations` 需要官方 operations export 的声明及目标文件均通过只读探测；只通过 DSH 命令探测、缺少可验证源码时，该项为 `disabled`。

`runtime.mutationsSupported=false`（能力矩阵中的 `mutations=false`）表示通用、完整的环境写能力仍未开放。它不代表 `apply` 命令不存在：当前 `apply` 通过 DSH CLI 执行 `install/update/remove`，通过 Profile `dsh.profile.bundles` 执行 `enable/disable`，并对 `configure` 写入 `cordis.patch.yml` 受管块。计划之外的通用环境变更仍不受支持。

### 2. `dshenv init`
在 `$DSH_HOME/envctl/` 下初始化空的清单、锁文件与初始状态。

```bash
dshenv init
dshenv init --dsh-home /path/to/custom-dsh
```

### 3. `dshenv capture`
无损盘点现有 DSH Profile 并生成待审阅的候选清单。

```bash
# 输出到控制台
dshenv capture

# 只捕获一个 Profile
dshenv capture --profile web

# 原子写入审阅文件（若目标文件已存在则拒绝覆盖）
dshenv capture --output my-dsh-backup.yaml
```

### 4. `dshenv adopt`
接管来自 `capture` 生成的候选清单，建立明确的插件所有权记录。

```bash
dshenv adopt my-candidate.yaml               # 预览会接管哪些插件，有待接管时退出码 2，不写文件
dshenv adopt my-candidate.yaml --yes         # 校验候选事实一致性并接管所有权
```

不带 `--yes` 时 `adopt` 只列出将接管的插件；带 `--yes` 才写入清单、锁文件和状态。

接管的 Profile 中写在 `cordis.patch.yml` 受管块之外的条目，`adopt` 会按 [`dshenv pull`](#22-dshenv-pull) 的规则一并收进清单。

本地来源（`link:`、`file:`）的插件带有本机绝对路径，`adopt` 不写进 base，而是同 `pull` 一样放进本机 overlay（没有选中的 overlay 时新建并选中 `local`）并记录源码摘要，预览中标为 `into an overlay`；`--no-overlay` 且未选 overlay 时在写入前以退出码 3 拒绝。base 已声明的同名包仍在 base 中更新。

### 5. `dshenv plan`
比对期望清单与当前 Profile 实际安装状态，计算变更计划。

```bash
dshenv plan
dshenv plan -p web     # 只看一个 Profile
```

### 6. `dshenv apply`
基于受管清单与锁文件，将期望状态安全收敛应用到 DSH 运行环境中（具备独占写锁、快照备份与操作日志审计）。

```bash
# 模拟执行（不修改磁盘或获取排他锁）；有变更时退出码 2
dshenv apply --dry-run

# 执行变更并提交状态
dshenv apply --yes

# 只应用一个 Profile，与 plan -p web 看到的一致
dshenv apply -p web --yes
```

`-p` 与 `plan -p` 一样只读取、只改动这个 Profile 的插件与 profile patch，其他 Profile 的所有权与重启记录原样保留；skill 在 `$DSH_HOME/skills` 下、不属于任何 Profile，照常一并应用。

不带 `--yes` 的 `apply` 与 `--dry-run` 相同：展示计划、有变更时退出码 2，并在 stderr 提示加 `--yes` 重跑。`pull`、`rollback`、`gc`、`purge`、`adopt`、`remote add`、`remote remove`、`remote sync` 同样如此：不带 `--yes` 只预览，有待执行的内容时退出码 2，没有时退出码 0。例外：要做的事无从做起时按错误处理，退出码 3，例如没有任何快照时的 `rollback`、没有订阅时的 `remote remove`。

当前执行计划中的 `install/update/enable/disable/remove/configure`。`configure` 只写入 Profile `cordis.patch.yml` 的受管块。没有所有权记录的实际插件只标为 `unmanaged`，不会卸载。

`apply`（含 `--dry-run`）会对有操作的 Profile 各运行一次 `dsh --profile <p> --dump-config`（超时 15 秒），读其中的 `hmr` 行判断 DSH 热加载是否开启，据此报告哪些改动无需重启：

| 操作 | 热加载开启 | 热加载关闭或无法判断 |
| --- | --- | --- |
| `install`、`enable`、`disable`、`configure`、`remove` | 无需重启（state 记为 `healthy`，`remove` 删除条目） | 需要重启（`restart-required`） |
| `update`（npm 版本、Git commit、本地源码变化） | 需要重启 | 需要重启 |

成功后在计划之后输出分组，某组为空时省略，没有需要重启的项时不输出 `Then run` 行：

```text
No restart needed:
  [web] enable @nanmicoder/dsh-agent-teams
Restart DSH to load:
  [web] update shared-plugin (package updates are not hot-reloaded)
  [cli] install tool-x (hot reload is off for profile cli)
Then run: dshenv mark-restarted
```

`--dry-run` 在每个计划操作后标注 `(no restart)` 或 `(restart required: <原因>)`。`--json` 结果新增 `restart: { notRequired, required }`，每项为 `{ profile, package, kind, reason, detail? }`，`reason` 取 `hmr-on`、`package-update`、`hmr-off`、`hmr-unknown`，`detail` 只在 `hmr-unknown` 时出现，为探测失败的原因。Profile 尚未创建时不运行探测（`--dump-config` 会创建 Profile），按无法判断处理。

`apply --yes --verify` 在应用之后，对每个有操作的 Profile 像 `verify` 一样核对运行中的 `dsh web`（先看 `DSHENV_DSH_URL`，否则用 `dshenv web start` 启动的那个；有操作的 Profile 不止一个时不用 `DSHENV_DSH_URL`，因为无法判断它指向哪个 Profile，只核对各自 `web start` 启动的那个），并输出同样的核对结果。结果仍可能随热加载改变（`loading`、`not-loaded`、`still-loaded`）时每秒再问一次，最多等 `--verify-timeout <秒>`（默认 30）；`failed`、`missing` 等立即报告。退出码与 `verify` 相同：都已加载为 0，超时仍在加载为 2，加载失败或核对出错为 5。没有 `dsh web` 在运行的 Profile 在 stderr 注明 `Not verified`，不影响退出码；不带 `--yes` 时拒绝 `--verify`（退出码 3）。`--json` 结果新增 `verify`，每项为 `{ profile, endpoint, results }`、`{ profile, skipped }` 或 `{ profile, error }`。

dshenv 改写 Profile `package.json`（启用、停用、卸载前移出 bundle）或 `cordis.patch.yml`（写入、清除受管块及回滚恢复）时持有 DSH 的 `package.json.lock`，被占用时最多等 30 秒。热加载开启时卸载插件会先移出 bundle、等待 3 秒让 DSH 卸下插件，再调用 `dsh plugin remove`；插件本来就不在 bundle 列表中时不等待。apply 失败回滚 `cordis.patch.yml` 时，如果 DSH 在 dshenv 写入之后又改过该文件，只把该插件的受管块恢复原样，DSH 的改动保留。

几点说明：

- 「无需重启」表示 DSH 会自动重新加载；dshenv 不确认插件是否真的加载成功（DSH 只在日志里记录重新加载失败）。
- `configure` 会列在分组里，但不写入 state，所以只含 `configure` 的 apply 之后运行 `dshenv mark-restarted` 可能显示清除了 0 个插件。
- 判定为无需重启的 `remove` 会连同该插件此前的 `restart-required` 条目一起删除（插件已经不在了）。
- 等 Profile 锁超时后 apply 会回滚，但回滚本身写 bundle 与 `cordis.patch.yml` 时也可能要等这把锁；回滚未能完成时运行 `dshenv plan` 查看现状。DSH Web 安装插件时整个安装过程都持锁，可能超过 dshenv 的 30 秒等待，等安装结束后再重试。

### 7. `dshenv rollback`
从 `envctl/backups/` 恢复最近一次（或指定 operation id 的）管理文件快照（rollback 自己也会先存一份 `pre-rollback-*` 快照，所以连续执行不带 id 的 `rollback` 会在两个状态之间来回切换；要再往前退须指定 id）：`manifest.yaml` / `lock.json` / `state.json`、`envctl/skills`、`remote.json`，以及快照时保存的 overlay（团队 overlay、`pull`/`sync` 改写的本机 overlay、`apply` 时生效的 overlay）。不带 id 时跳过失败的 `apply` 留下的快照（它们已经自己恢复了 `lock.json` 与 `state.json`，恢复它们等于什么都不做），输出会写明跳过了哪些；`apply` 的快照保存的正是它所应用的清单与 overlay，所以回到某次成功的 apply 就是回到它应用的清单。不撤销已经发生的 DSH 包安装；由 `apply` 安装、仍装在 Profile 里的插件保留所有权记录，之后从清单删除时照常卸载。`DSH_HOME/skills` 里仍与 dshenv 上次同步时一致的 skill 同样保留基线，恢复后的清单不再声明它时，下一次 `apply` 把它移进 trash。恢复前会把当前这些文件另存为一份新快照（输出中给出其 id，可再 rollback 回去）；快照里没有的文件会被删除。

```bash
dshenv rollback --dry-run
dshenv rollback --yes
dshenv rollback apply-abc123 --yes
```

### 8. `dshenv gc`
删除 `envctl/trash/` 中超过保留期的条目，以及 `envctl/backups/` 中超过保留期的快照（始终保留最近 10 个，`rollback` 只能回到还在的快照）。默认 7 天。不会删除这两个目录之外的路径。

```bash
dshenv gc --dry-run
dshenv gc --yes
dshenv gc --older-than 3 --yes
```

### 9. `dshenv purge`
把有所有权的受管 patch（以及 `envctl/sources/<profile>/<package>` 下的 clone）移入 `envctl/trash/<operation-id>`。不删除外部 Git 目录、Profile 根或凭据。`apply` 删除插件后所有权记录随之去掉，这时用包名执行 `purge` 仍可清理它留在 `envctl/sources` 下的 clone（清单不再声明该包时）。

```bash
dshenv purge agent-teams --profile web --dry-run
dshenv purge agent-teams --profile web --yes
```

### 10. `dshenv plugins list`
以表格列出清单中的插件（`PROFILE ALIAS PACKAGE VERSION ENABLED INSTALLED`，有生效 overlay 时加 `ORIGIN` 列），以及 plan 标出的 unmanaged 包（别名显示为 `(unmanaged)`）。非 npm 来源的 `VERSION` 列写来源类型；没有插件时提示如何添加。

```bash
dshenv plugins list
dshenv plugins list --profile web --json
```

### 11. `dshenv update`
只改清单（以及已有 lock 条目）里的精确 npm 版本，不解析 latest。随后用 `apply --yes` 真正更新。

```bash
dshenv update agent-teams --profile web --to 0.1.22
```

### 12. `dshenv plugins config`
读取或改清单中的插件配置。`set` 只写 manifest；`apply` 才会落到 `cordis.patch.yml`。

```bash
dshenv plugins config get agent-teams --profile web
dshenv plugins config get agent-teams taskPlanning --profile web   # 只读一个字段
dshenv plugins config validate agent-teams --profile web
dshenv plugins config set agent-teams taskPlanning captain --profile web
dshenv plugins config unset agent-teams taskPlanning --profile web     # 删掉一个键
```

- 值按 JSON 解析（`3`、`true`、`{"a":1}`），解析不了时当作字符串；要写字符串 `"3"` 就传 `'"3"'`。
- DSH 用补丁的 `config` 整体替换插件的配置，所以清单里还没有这个插件的补丁时，`config set` 先把 DSH 当前为它组合出的全部配置（`dsh --dump-config`，含 `!!js` 表达式）抄进补丁，再改这个键，插件的默认值得以保留；之后的 `config set` 只改各自的键。只在没有 dshenv 补丁生效时这样做（含 overlay 给它的补丁，否则抄到的是那份补丁而不是默认值）；抄来的配置含本机路径时写 base 以退出码 3 拒绝，改用 `--layer overlay`。抄不了时（DSH 还没有这个插件、Profile 未创建、DSH 无法运行，或已有补丁生效）只写这个键，并在 stderr 说明原因。新补丁的 id 取 DSH 加载该插件的那一行（bundle 插件的行 id 可能与别名不同）；键只写进 `enabled` 不为 `false` 的补丁，全都禁用时以退出码 3 拒绝。
- DSH 为该插件组合出了配置而其中没有这个顶层键时，`config set` 在 stderr 提示一行（附相近的键名）后照常写入：DSH 只组合出带默认值的键，插件文档里的键可能不在其中。`--force` 不再提示。
- 读取或删除不存在的键时以退出码 3 报错；只认配置里自己的键，不会读到 `toString` 这类继承来的属性。路径为空，或含 `__proto__`、`prototype`、`constructor` 时以退出码 3 拒绝。
- `config unset` 在该插件声明的所有 patch 里找这个键；删完后什么都不设的 patch 会一并删掉，不留下 `config: {}`。

```bash
```

### 13. `dshenv status`
显示当前环境状态摘要与操作统计；给出插件别名或包名时只显示该插件。有待执行的变更时退出码 2，环境已同步时为 0；环境降级（`degraded`）或 DSH 不兼容（`incompatible`）时为 5。

```bash
dshenv status
dshenv status agent-teams -p web
dshenv status --json
```

### 14. `dshenv source clone`
带 `--profile` 时克隆到 `envctl/sources/<profile>/<package>`，并把 HEAD commit 写入 lock；包名取仓库 `package.json` 的 `name`（可用 `--package` 指定）。清单里这个别名已声明同一仓库的 `commit` 或 `ref`（如 `install <url>#<sha>` 写入的）时，克隆并锁定它而不是 HEAD，commit 不在仓库里时报错；给了 `--ref` 时改用该 ref 并写进清单。别名默认与 `install` 相同（仓库名去掉 `dsh-plugin-`、`dsh-` 前缀）；别名已指向另一个包时拒绝（退出码 3）。本机仓库的路径（如 `/src/plugin`）记为 `file://` 地址，pnpm 才会按 Git 仓库安装。带账号密码或 token 的 URL 会被拒绝，请改用 SSH 或 git credential helper。随后 `apply --yes` 才能安装。显式给出目标目录时仍可克隆到外部路径（`purge` 不会删除外部目录）。

```bash
dshenv source clone https://github.com/ex/plugin.git --profile web --as demo
dshenv source clone https://github.com/ex/plugin.git ./external-checkout
dshenv source show -p web --as demo            # 受管 clone 的 Git 状态（是否有未提交改动、commit、分支）与源码摘要
dshenv source sync -p web --as demo            # 快进受管 clone，并把新的 HEAD commit 写入 lock
dshenv source sync -p web --as demo --ref v1.2.0
```

`source show` / `source sync` 不带 `--profile` 时作用于给出的目录（不给时为当前目录），`sync` 只快进、不写 lock，`--ref` 指向更旧的 commit 时以退出码 3 拒绝；不给 `--ref` 时快进到当前分支对应的远端分支，处于 detached HEAD 时须给 `--ref`。带 `--profile` 时，Profile 里恰好有一个 Git 插件可省略 `--as`；`envctl/sources` 下的受管 clone 也可以用 `--ref` 退回到更旧的 commit（如 `plan` 提示的清单 commit），处于 detached HEAD 且不给 `--ref` 时跟随清单的 `ref`，没有时跟随远端默认分支；清单锁定的 `commit` 与新 commit 不一致时在 stderr 提示（`plan` 会显示 blocked）。`sync` 总是按清单中的 URL 写入完整的 lock 条目，之后 `apply --yes` 安装新 commit。base 与所有 overlay 都不再声明的别名，其 lock 条目在下次 `apply` 时删除，之后用同一别名重新加入的 Git 插件须重新锁定 commit。

不是 DSH bundle 的插件包（`package.json` 没有 `dsh.bundle`，例如 [dsh-session-search](https://github.com/Tieboyh/dsh-session-search)）不能放进 bundle 列表，DSH 会跳过它。dshenv 在安装后检查包类型，这类插件改为在 `cordis.patch.yml` 里写一个受管的 `insert` 行挂载（`# dshenv:begin ... plugin=@mount:<alias>`），`enable`/`disable` 切换这一行，`verify` 按已加载的插件条目判断。

### 15. `dshenv overlay`
按机器/环境在 base 清单（`envctl/manifest.yaml`）之上叠加 `envctl/overlays/<name>.yaml`。

```bash
dshenv overlay create laptop   # 新建空 overlay：envctl/overlays/laptop.yaml
dshenv overlay use laptop      # 本机持久选择
dshenv overlay use --none      # 清除选择
dshenv overlay list            # 列出 overlay，标出当前生效项
dshenv overlay show --json     # 合并结果与每个插件的出处
dshenv plan --overlay server   # 单次命令临时指定
dshenv plan --no-overlay       # 单次命令只用 base
```

overlay 文件格式与清单相同的 `profiles` 结构，只写需要覆盖的字段；插件条目写 `remove: true` 删除 base 中的同名插件，Profile 级 `patches` 中写 `{ id, remove: true }` 删除同 id 的条目；插件自己的 `patches` 只能按 id 覆盖或新增，不能删除：

```yaml
apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      agent-teams:
        enabled: false            # 覆盖 base 中的字段
      local-tool:                 # 只在本机存在的插件
        package: "@me/local-tool"
        source: { type: local-link, path: /home/me/src/local-tool }
      old-plugin:
        remove: true              # 本机不装 base 中的这个插件
```

选择优先级：`--overlay` 或 `--no-overlay`（两者同时使用时报错，退出码 3）> `DSHENV_OVERLAY` > 本机选择文件。选中的 overlay 不存在或无效时报错，不会退回只用 base。overlay 里对 base 已不再声明的插件写的 `remove: true` 或字段覆盖（不带 `package`）不起作用、也不报错，例如团队 `sync` 删掉了本机 overlay 停用或改了来源的插件；带 `package` 的条目仍按新增插件处理，必须写 `source`。有生效 overlay 时，改清单的命令（`install`、`update`、`enable`、`disable`、`remove`、`plugins config set/unset`、`tools enable/disable/config/reset`、`source clone --profile`、`new -p`）必须带 `--layer base` 或 `--layer overlay`；也可以设环境变量 `DSHENV_LAYER` 作为默认值，它只在有生效 overlay 时起作用，使用时会在 stderr 提示。`adopt` 不需要 `--layer`：共享的插件写 base，本地来源的插件进 overlay。

### 16. `dshenv mark-restarted`
`apply` 输出 `Restart DSH to load:` 分组时，其中插件的状态标为 `restart-required`（升级了已装插件，或该 Profile 的热加载关闭、无法判断）。热加载开启时的安装、启用、停用、配置与卸载当场生效，不需要本命令。重启 DSH 后运行本命令确认，清除该状态（已卸载插件的条目一并删除）。dshenv 无法自行判断 DSH 是否已重启。

```bash
dshenv mark-restarted
dshenv mark-restarted --profile web --json
```

旧名 `dshenv restarted` 仍可使用。

```bash
```

#### verify：核对运行中的 DSH 是否已加载

`apply` 只能推断改动是否已被热加载。`dshenv verify` 登录运行中的 `dsh web`，读取 Plugin Manager 报告的真实加载状态，与清单对比：

```bash
export DSHENV_DSH_URL='http://127.0.0.1:3080/?token=...'   # dsh web 启动时打印的地址
dshenv verify --profile web
```

- 没有设置 `DSHENV_DSH_URL` 时，使用 `dshenv web start` 为该 Profile 启动并仍在运行的 dsh web（见第 24 节）。
- 也可以用 `dshenv verify --profile web --start` 临时启动一个（`dsh --profile web --no-open --port 0`），核对完即停止；它不读取 `DSHENV_DSH_URL`，Profile 须已存在。
- 显式给出地址只能用环境变量 `DSHENV_DSH_URL`，没有对应的命令行参数。地址等同于登录凭据，dshenv 不会输出或记录其中的 token；默认只连本机，连其他主机需加 `--allow-remote`，且地址必须是 https（明文 http 会把 token 暴露在网络上）。
- 只适用于 `dsh web`；headless、sdk、acp 运行不开 web 服务，无法核对（`--start` 以退出码 3 报 `Profile <p> runs <应用包>, not dsh web`）。
- 每个插件的结果：`loaded`、`unloaded`（符合清单），`loading`（热加载进行中，也覆盖 `apply` 之后 DSH 还未热加载的瞬间；若持续为 `loading`，说明热加载没有生效，需重启 DSH；带 `is waiting for services it injects` 时，是插件依赖的 service 还没有任何插件提供，检查是否漏装或停用了提供它的插件），`unverifiable`（包没有可核对的插件行），`missing`、`failed`、`not-loaded`、`still-loaded`（与清单不符）。
- 退出码：`0` 全部符合；`2` 仍在加载，稍后重跑；`5` 有不符项；`1` 无法连接、登录失败或运行中的 DSH 不是该 profile；`3` 用法错误。
- 不核对版本：DSH 只报告磁盘上的版本，看不出内存中加载的是哪个版本；升级插件后仍需重启 DSH。

### 17. 在 CI 中使用
仓库自身的 CI 见 `.github/workflows/ci.yml`（Node 22/24 上跑 typecheck、test、build，合入 `master` 必须通过）。对真实 DSH 的检查与之分层：`e2e.yml` 在 PR 与 `master` 上对已验证的 DSH 跑主链端到端测试（`make e2e-dsh DSH_VERSION=<版本>`），`compat.yml` 每天对已验证版本、`latest` 与 `next` 跑兼容冒烟（`make smoke-dsh`）。在你的配置仓库里校验清单与 overlay、在真实环境上做漂移门禁，可参考 `docs/examples/github-actions/dshenv-check.yml`，说明见 `docs/使用教程.md` 第 15 节。

### 18. `dshenv new`

从模板生成 DSH 组件包，可选直接登记进清单：

```bash
dshenv new skill code-review            # skill bundle：skills/code-review/SKILL.md
dshenv new skill code-review --loose    # 直接写入 $DSH_HOME/skills/code-review/SKILL.md
dshenv new agent reviewer               # agent 预设（dsh-agent-preset + dsh-persona）
dshenv new tool echo-text -p web        # 纯 JS tool 插件，并登记到 profile web
dshenv new tool echo-text --typescript  # TypeScript 版本，需先 pnpm install && pnpm build
dshenv new mcp docs-server              # MCP server 配置包
```

- 名称必须是 kebab-case；目标目录非空时拒绝。
- `-p` 等同于随后执行 `dshenv install <目录> -p <profile>`（支持 `--as`、`--layer`）；登记失败时删除生成的目录。不会自动 `apply`。

### 19. 容器示例

`docs/examples/container/` 提供构建 DSH Web 容器镜像的 `Dockerfile`、`compose.yaml` 与 `cordis.patch.yml`，镜像构建期执行 `dshenv apply` 装好清单声明的插件。安全要点：容器内监听 `0.0.0.0` 只是为了让 Docker 转发端口，宿主机端口必须只发布到 `127.0.0.1`（不要用 `-P`），否则会把 DSH Web 的 shell 执行能力暴露到局域网；回环发布挡不住同一 Docker 网络内的其他容器，它们能直接访问容器 IP 并通过 Host 校验，只剩启动 token 一道防线，因此应放在独立的自定义网络上（compose 的项目网络即可，但同项目新增的服务也能访问）。完整用法、构建参数与数据卷说明见 `docs/examples/container/README.md`。

### 20. `dshenv remote`

团队在一个 Git 配置仓库中维护 base 清单、lock 与团队 overlay（默认读取仓库内 `envctl/`），成员订阅后按固定 commit 显式接受更新：

```bash
dshenv remote add git@github.com:team/dsh-config.git          # 预览：文件变化与接受后的 plan，退出码 2，不写文件
dshenv remote add git@github.com:team/dsh-config.git --ref <commit> --yes   # 接受预览过的那个 commit（预览末尾给出这条命令）
dshenv remote show                                           # URL、分支、固定 commit、远程文件与 lock 条目及本地改动
dshenv remote sync                                           # 拉取并预览更新，退出码 2；已是最新时退出码 0
dshenv remote sync --ref <commit> --yes                      # 接受预览过的更新（只接受 fast-forward），之后自行 plan / apply
dshenv remote sync --ref v1.2.0 --yes                        # 移动到订阅分支上的某个 tag 或 commit
dshenv remote remove                                         # 预览取消订阅，退出码 2
dshenv remote remove --yes                                   # 取消订阅，文件保留为本地文件
```

顶层的 `dshenv sync` 是 `remote sync` 的旧名，仍可使用。

- 只采用 `<path>/manifest.yaml`（必需）、`<path>/lock.json`、`<path>/overlays/*.yaml` 与 `<path>/skills/<名字>/...`（团队 skill，随 `apply` 装进 `DSH_HOME/skills`）；`--path` 指定仓库内目录（`.` 为仓库根），`--branch` 指定分支（默认远程 HEAD 所指分支）。团队 manifest、团队 overlay 与团队 lock 都不能使用 `local-link` / `local-file` 源或指向本机的 Git 地址（`file://`、本地路径），团队 manifest 与团队 overlay 也不能设置 `environment.harness.sourceDir` / `environment.sourceRoot`（本机路径无法跨机器共享，且 dshenv 会执行该目录下的 DSH），团队 manifest 与团队 overlay 的插件 patch 与 profile patch 也不能含 JavaScript 表达式（`__jsExpr`，dshenv 会把它写成 DSH 执行的 `!!js` 值），否则整个 commit 被拒绝；这些请写在本机 overlay 里。这些限制并不让团队配置变得无害：团队声明的插件会被安装并运行，插件配置（如 `dsh-mcp-client` 的 `command`）与 profile patch 也能让 DSH 在成员机器上启动进程。只订阅可信的仓库，并在 `sync --yes` 前审阅预览。
- `manifest.yaml` 与团队 overlay 整文件归远程；`lock.json` 按 `profile/alias` 条目归属：团队 lock 中的条目归远程，其余条目（本地 overlay 插件的 Git commit、本地源摘要）归本机，同步时只替换团队条目。本地 overlay 把团队 lock 已固定的插件改为 `local-link` / `local-file` 源时，`apply` 以退出码 3 拒绝；应在本地 overlay 中对它写 `remove: true`，再以新 alias 加入本地源插件。
- 远程内容只读：写 base、写远程 overlay、改写团队 lock 条目的命令都以退出码 3 拒绝；本机定制写本地 overlay（`--layer overlay`），`source clone --profile` 等写本机条目的命令照常可用。
- 本地已有 `manifest.yaml`、同名 overlay，或本地 lock 已有团队 lock 同名条目时，`remote add` 需要 `--replace`（先快照再覆盖）；本地改过远程文件或团队条目时 `sync` 拒绝，`--discard-local-changes` 可覆盖。
- 团队仓库提供的 skill（`skills/<名字>/...`）整个目录归团队所有：`envctl/skills` 里已有不归团队的同名 skill 时，`remote add` 与 `sync` 都拒绝（`--replace` 也不行，以免两份混在一起），需先移走本地的那份。
- 每次接受都会先建快照，用 `dshenv rollback <快照 id> --yes` 撤销（id 见接受时输出的 `snapshot ...`；之后又 `apply` 过时，不带 id 的 `rollback --yes` 只会撤销那次 apply）；接受后不会自动 `apply`。接受更新即同意执行其中声明的插件。
- URL 不得内嵌凭据（认证交给 SSH 或 git credential helper）；git 失败时退出码 1，并带出 git 的原始错误。
- 预览之后分支可能又有新提交，不带 `--ref` 的 `--yes` 接受的是那时的最新 commit；预览末尾给出带 `--ref <预览的 commit>` 的命令，用它接受的正是审阅过的内容。
- `--json` 时 `sync` 输出 `{status, from, to, files: {added, modified, removed}, lockEntries: {added, modified, removed}, plan}`，接受时另有 `operationId` 与 `snapshotId`；lock 条目写作 `<profile>/<alias>`，`status` 为 `up-to-date`、`pending` 或 `accepted`。

### 21. `dshenv self-update`

查询或升级 dshenv 自身，用法与安装方式的判断见[升级 dshenv](#升级-dshenv)。`--json` 输出 `{status, current, target, direction?, method?, command?}`：`status` 为 `up-to-date`、`newer-installed`（本机版本高于最新版，不做改动）、`available`（仅 `--check`）或 `updated`；`direction` 为 `upgrade` 或 `downgrade`；`method` 为 `npm`、`pnpm`，无法自行替换时为 `null`。

### 22. `dshenv pull`

把 DSH 里改动的设置和装进 Profile 的插件收进清单，是 `apply` 的反方向。你在 DSH 界面里改模型、语言等设置时，DSH 会改写 Profile 的 `cordis.patch.yml`；`plan` 会在 `Patch entries not in the manifest` 下列出受管块之外的条目，或提示受管块在 DSH 里被改过。

```bash
dshenv pull                        # 预览，有变更时退出码 2（与 --dry-run 相同）
dshenv pull --yes                  # 收进清单，并把这些条目整理进 dshenv 的受管块
dshenv pull --yes --profile web    # 只处理一个 Profile
dshenv pull --yes --prefer dsh     # DSH 与清单都改过时，以 DSH 为准（--prefer manifest 以清单为准）
```

- 条目写进清单的 `profiles.<profile>.patches`，原样保留 `id`、`name`、`config`、`disabled`、`insert` 与 `!!js` 表达式（清单里记作 `{ __jsExpr: ... }`）。
- 含本机绝对路径（如技能目录）的条目写进当前 overlay；没有选中 overlay 时新建并选中 `local`。带 `--no-overlay` 时遇到这类条目会拒绝。订阅了团队 remote 时基础清单只读，全部条目写进本机 overlay。
- 自上次 `apply` 以来 DSH 与清单都改过时拒绝执行，需用 `--prefer` 指定以哪一边为准。
- `plan` 在 `Unmanaged plugins` 下列出的插件（装在 Profile 里、清单没有声明）也一并接管，描述方式与 `capture` 相同（别名、来源、版本；只靠 `insert` 加载、不在 bundles 里的记为 `enabled: false`），并像 `adopt` 一样写入 lock 与所有权记录，之后 `plan` 不会要求重装；`local-file` 插件除外：装进 Profile 的是当时的副本，无法证明与源目录一致，下一次 `apply` 会重装一次以记下源码 digest。`local-link`/`local-file` 插件按含本机路径条目的规则写进 overlay（`local-link` 同时记下源码 digest），其余写进基础清单；团队 remote 拥有基础清单时写进 overlay。`adopt` 之后的那次 `pull` 只接管候选清单中的本地来源插件。
- 写入前先建快照，`dshenv rollback <快照 id> --yes` 可撤销（id 见 `--json` 输出的 `snapshotId`）。
- `$DSH_HOME/skills` 下的 loose skill 也一并处理：目录复制到 `envctl/skills/<名字>`，DSH 里删掉的技能从清单里删除。`apply` 反向复制，被覆盖或删除的 DSH 副本移进 `envctl/trash`（`gc` 清理）；`plan` 在 `Planned skill changes` 与 `Skills not in the manifest` 下列出技能。`envctl/skills` 可以放进团队配置仓库，随 `remote`/`sync` 同步；团队拥有的技能在 DSH 里改动后 `pull` 会拒绝。Git 标记为可执行的文件同步后保持可执行；只改可执行位的提交也会同步，skill 的摘要同样计入可执行位，所以这类改动会一直到 DSH 里的副本（Windows 没有可执行位，不比较）。
- `--json` 输出 `{dryRun, changes: [{profile, from, added, changed, removed, base, overlay, overlayName?}], skills?: {added, changed, removed}, plugins?: [{profile, alias, package, sourceType, enabled, layer, overlayName?}], warnings?, overlayCreated?, operationId?, snapshotId?}`；`warnings` 列出无法接管的插件（如 npm 版本不是确定版本）。

### 23. `dshenv tools`

按 DSH 架构图的分类（终端、文件、网络、代码、编排、交互、会话/技能/自省）列出、开关和配置 Profile 里的内置工具。工具状态读自 `dsh --profile <p> --dump-config`，所以需要 Profile 已存在、DSH 可以运行（`--harness-source`、`DSH_CLI` 或 PATH）。

```bash
dshenv tools list -p web                                   # 默认预设的工具：+ 开启，- 关闭，~ 按条件关闭
dshenv tools list -p web --preset ptc                      # 看另一个 agent 预设；--all 列出每个位置
dshenv tools disable tool-web -p web                       # 关闭；enable 打开（id 见 tools list）
dshenv tools config get tool-web -p web                    # 查看配置；加 <路径> 看单个键
dshenv tools config set tool-web fetchMaxOutputChars 20000 -p web   # 设置一个键
dshenv tools config unset tool-web fetchMaxOutputChars -p web       # 删掉一个键
dshenv tools reset tool-web -p web                         # 删掉改动它的 patch，恢复 DSH 的默认
dshenv apply --yes                                         # 写进 DSH
```

- `tools config get|set|unset` 与 `plugins config` 写法相同；旧写法 `tools config <tool> [路径] [值]` 仍可使用。tools 写 base 时，若这条在清单 base 里还没有，而 DSH 当前组合出的配置已含 dshenv 补丁（如已 apply 的 overlay 写的），或含本机路径，以退出码 3 拒绝，改用 `--layer overlay`。
- 结果写进清单的 `profiles.<profile>.patches`，与 `pull` 管理的条目相同；overlay 激活时用 `--layer base|overlay` 选择写入层。
- 顶层工具行（如 headless Profile）只写一条小 patch：`{id, name, disabled}` 或 `config`。DSH 的 patch 会整体替换一行的 `config`，所以 `config` 设置时会把当前整份配置连同改动一起写入。
- web 等 Profile 的工具在 agent 预设（`preset-standard`、`preset-ptc` 等）里，按 id 的 patch 够不到预设内部，只能整份替换预设的 `config`。dshenv 会把当前预设整份复制进清单再改目标工具（`!!js` 条件原样保留），这个预设从此**固定**：DSH 升级对它的改动不再生效，`plan` 会在 `Pinned agent presets` 下列出。删掉清单里那条预设 patch 并 `apply`，即恢复跟随 DSH。
- 目标与 `tools list` 显示的一致：先找 `--preset` 指定的预设（不指定时用 DSH 当前的默认预设），其中没有该工具时改 profile 级那一行；只有别的预设里有时报错，提示加 `--preset`。
- overlay 已声明同一个 id 的条目时，写 base 会被它覆盖而不生效，因此会拒绝，请改用 `--layer overlay`。
- 只接受 `tools list --all` 列出的 id；不在 Profile 组合里的工具（如默认未装的 `tool-lsp`、`tool-terminal`）不能用 `enable` 打开，需先安装对应的包。
- `tools reset <tool>` 删掉清单里改动该工具的那条 patch：顶层工具只删它自己的，预设里的工具会删掉整个预设 patch（该预设内的所有工具改动一起撤销，预设恢复跟随 DSH）。overlay 里写时，base 声明的 patch 记为 `remove: true`；已经记过的再 reset 一次什么也不改。


### 24. `dshenv web`

在后台启动、停止和查看 dsh web，不必占着一个终端：

```bash
dshenv web start -p web            # 后台启动，打印浏览器地址；--port 3080 指定端口，默认随机空闲端口
dshenv web list                    # 列出 dshenv 启动的 dsh web：运行状态、pid、地址（不含 token）；-p 只看一个 Profile
dshenv verify -p web              # 没设 DSHENV_DSH_URL 时自动连这个 dsh web
dshenv web stop -p web             # 停止它以及它启动的子进程（如 stdio MCP 服务），等全部退出后返回
```

- 启动命令为 `dsh --profile <P> --no-open --port <端口>`，DSH CLI 的选择与其他命令相同（`DSH_CLI`、`--harness-source`、`environment.harness.sourceDir`、`PATH`）。DSH 的 `cordis.patch.yml`（如 `$DSH_HOME/cordis.patch.yml`）设置了 `webserver.port` 时，DSH 忽略 `--port`，`web start --port` 与 `verify --start` 的随机空闲端口都不起作用。dsh web 在独立的进程组中运行，dshenv 退出或关闭终端后继续运行。
- 地址（含登录 token）与 pid 记在 `envctl/run/<profile>.json`，输出写到 `envctl/run/<profile>.log`，两者权限均为 `0600`；不在快照、同步与团队仓库范围内。`start` 打印地址，已在运行时再次 `start` 也会打印现有的地址；`web list`（旧名 `web status`）从不打印 token。
- 已在运行时 `start` 只报告现有的那个；它自己退出后，`status` 显示 `not running`，再次 `start` 会启动新的。dsh web 自己退出但它启动的子进程还在时，`status` 显示 `not running (leftover processes)`，`start` 先停掉这些子进程再启动，`stop` 也会停掉它们。
- 记录里保存了 dsh web 的启动时间，`stop` 只停止 pid 与启动时间都对得上的进程，被系统复用的 pid 不会被误停；无法确认时（`status` 显示 `unknown`）`stop` 和 `start` 报错并保留记录，不做任何停止。SIGKILL 后仍未退出时 `stop` 以非零退出码报错并保留记录，可以再次执行。
- 同一 Profile 的 `start`、`stop` 依次执行，两个 `start` 同时运行也只会启动一个；启动过程中按 Ctrl+C 会停止正在启动的 dsh web（`verify --start` 在核对过程中被中断也一样），不会遗留进程。
- Profile 必须已存在（DSH 会自动创建不存在的 Profile）；bundles 选了其他应用（`dsh-headless`、`dsh-acp-app`、`dsh-sdk-app`）的 Profile 以退出码 3 报 `Profile <p> runs <应用包>, not dsh web`，60 秒内没有打印地址也会停止并报错。
- Windows 上 dsh web 以 detached 方式启动，不附着在启动它的控制台上，关闭启动它的控制台窗口后继续运行；停止用 `taskkill /T /F` 结束整棵进程树。

### 25. `dshenv install` / `enable` / `disable` / `remove`

只改清单，随后用 `dshenv apply --yes` 真正安装、启停或卸载：

```bash
dshenv install @nanmicoder/dsh-agent-teams@0.1.21 -p web        # npm 包，必须是精确版本
dshenv source clone https://github.com/ex/dsh-plugin-demo.git -p web   # Git 来源：克隆并在 lock 中固定 commit（见第 14 节）
dshenv install ./my-plugin -p web                               # 本地目录（./、../、绝对路径或 file:），登记为 local-link
dshenv install in-box:@deepseek-ai/dsh-acp-app -p acp           # 随 DSH 发布的 bundle，不装依赖，只在 Profile 中选中
dshenv disable agent-teams -p web                               # enable 反之
dshenv remove agent-teams -p web
```

`install in-box:<包>` 能从 DSH 的安装位置找到这个包时检查它是否 bundle（`package.json` 有 `dsh.bundle`），不是时以退出码 3 拒绝（DSH 会在每次启动时跳过它）；找不到时不检查。插件别名不能以 `@` 开头（dshenv 自己的补丁块用 `@profile`、`@mount:<别名>`）。

`install <git 地址>[#<commit|分支|tag>]` 只在清单里声明 Git 来源（`#` 后是 commit 时记为 `commit`，否则记为 `ref`）；Git 插件要在 `lock.json` 有固定的 commit 才能 apply，所以之后仍需 `source clone --profile` 或 `source sync --profile` 锁定，否则 `plan` 显示 `blocked`。

- 本地来源（`local-link`、`local-file`）由 `apply` 记录源目录摘要，目录内容变了 `plan` 才会提示更新。`package.json` 有 `files` 时只算 npm 会发布的文件（`package.json`、README、LICENSE、`main` 与 `files` 列出的内容，支持通配与 `!` 排除），改文档、测试等不算更新；没有 `files` 时算整个目录（跳过 `node_modules`、`.git`）。skill 总是算整个目录，不看 `files`。目录里的软链接按它指向的路径计入，不读取指向的内容；skill 在 `envctl/skills` 与 `DSH_HOME/skills` 之间复制时软链接原样保留，整个 skill 目录本身是软链接时复制其内容。
- 本地来源的目录必须存在（也可写成 `file://` 地址），且不能带 `#<ref>`；要按 Git 仓库安装本机仓库，写 `git+file://<路径>#<commit>`。
- 别名默认取包名（去掉作用域与 `dsh-plugin-`、`dsh-` 前缀），`--as` 指定。本地来源的包名默认读其 `package.json` 的 `name`（读不到时用目录名），Git 来源默认用仓库名，与实际包名不同时用 `--package` 指定（`source clone --profile` 会读仓库的 `package.json`）；`--package` 只对 Git 与本地来源有效。
- 同一别名重新 `install` 同一个包只改来源，保留 `patches` 与启用状态；输出会说明从哪个版本（来源）改成了哪个。别名已经指向另一个包时拒绝（退出码 3），用 `--as` 换一个别名，或先 `remove` 原来的。
- npm 来源（`install` 与 `update --to`）先用 `npm view` 核对：包在而版本不存在时以退出码 3 报错并给出最新版本。npm 看不到这个包（可能是需要凭据的私有包）、拒绝凭据，或查询不了（离线、超过约 5 秒）时只警告，照常写入清单。加 `--no-npm-check` 或设 `DSHENV_NPM_CHECK=off` 跳过核对；`--json` 输出的 `npmCheck` 是 `verified`、`unverified`、`unreachable` 或 `skipped`。包名不合法（例如以 `-` 开头）时直接拒绝，不会交给 npm。
- `enable`、`disable`、`remove`、`update`、`plugins config` 也接受包名；别名写错时报错会给出相近的别名。
- 输出统一为「改了清单 + 下一步」，如 `Added … to profile 'web' in the manifest. Next: dshenv plan, then dshenv apply --yes.`。
- `remove` 从清单删除该条目；写 overlay 时，base 中已有的插件记为 `remove: true`。`apply` 只卸载有所有权记录的插件（dshenv 安装或 `adopt` 接管的），其他实际存在的插件标为 `unmanaged`，不会卸载。`remove` 只改清单，无需确认；旧脚本里的 `-y`/`--yes` 仍被接受。`uninstall` 是 `remove` 的别名。
- 有生效 overlay 时这四个命令都须带 `--layer base|overlay`，或设环境变量 `DSHENV_LAYER=base|overlay` 作为默认（见第 15 节）。

---

## 退出码规范

| 退出码 | 含义 |
| :--- | :--- |
| `0` | 成功 / 环境与清单完全同步（Clean） |
| `1` | 意外失败（如 Git、npm 或网络错误） |
| `2` | 存在有效变更计划（Drifted，`plan`/`status`/`apply --dry-run`）；不带 `--yes` 的 `apply`、`pull`、`rollback`、`gc`、`purge`、`adopt`、`remote add`、`remote remove`、`remote sync` 预览有待执行的内容；`verify` 有插件仍在加载；`self-update --check` 有可安装的版本 |
| `3` | 用法错误（缺参数、未知选项或命令）或输入、清单格式校验失败（ValidationError）；`--json` 时以 `{"error": {...}}` 输出 |
| `4` | DSH 运行时能力不支持或未找到（CapabilityError） |
| `5` | 环境降级或运行时响应异常（DegradedError） |

---

## 安全边界与约束

1. **路径约束**：清单中的本地链接和本地文件路径必须为绝对路径；仍应只使用可信源码目录和规范的 npm 包名。Profile 名（清单、overlay、lock 与 `-p`）只能含字母、数字、`.`、`_`、`-`，不能以 `-` 开头，也不能是 `.` 或 `..`；Git 地址与 ref 不能以 `-` 开头，清单中的 `commit` 必须是 7-64 位十六进制 commit id。
2. **凭据使用约束**：不要把明文密钥写入清单、锁文件、patch 配置或源码 `package.json`。清单与 lock 中带账号密码或 token 的 git URL 会被 schema 拒绝，`capture` 会跳过这类依赖并告警。`doctor` 不回显 `DSH_CLI` 参数，但 `source show --json` 会输出源码包摘要，使用前应检查其中是否含敏感字段。
3. **非受管保护**：实际 Profile 中未写入 `manifest.yaml` 的插件保持 `unmanaged`，不会被自动删除（DSH 创建 Profile 时自带的 base/app bundle 不算 `unmanaged`）。
4. **锁与管理文件快照**：所有写 `manifest`/overlay/`lock`/`state` 的命令都先获取环境锁（最多等 5 秒）。`apply` 执行前备份当时已经存在的管理文件；失败时只原子恢复它自己会写的 `lock.json` 与 `state.json`（快照中不存在的会被删除），`manifest.yaml`、overlay 与 `envctl/skills` 保持原样，以免覆盖 apply 期间的手工修改；已成功安装的插件在恢复后仍记入所有权；恢复本身失败时错误信息会提示运行 `dshenv rollback <id> --yes`。某一步失败时，错误信息写明失败的步骤（如 `[web] install cc (cc), step 2 of 2`）、本次的 operation id、仍然留在 Profile 里的已装插件，以及回到上一次成功 apply 所用清单的命令 `dshenv rollback <上次的 id> --yes`。apply 还会逆序撤销本工具对 Profile `dsh.profile.bundles` 与 `cordis.patch.yml` 的改动；DSH CLI 已完成的包安装、更新或卸载不会撤销，已成功卸载的包也不会恢复其 bundle 与受管块。失败后应重新运行 `status` 与 `plan`。

---

## 后续路线图

见 `docs/roadmap.md`。后续版本计划交付：
- 配置补丁之外的 live manager 写能力
- 细粒度 live manager service 双向通讯

## 许可证

[MIT](LICENSE)
