# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程见 [docs/发布流程.md](docs/发布流程.md)。

## 未发布

### 修复

- 失败的 `apply` 恢复 `lock.json` 后，补记失败前已装上的本地来源插件的摘要；此前下一次 `plan` 会以「Local source has no recorded digest」重装同样的代码，并标记为需要重启。
- `rollback` 不再把 `mark-restarted` 已清除的 `restart-required` 带回来；重启状态以回滚前为准（DSH 进程不随 rollback 改变）。
- 没有 `state.json` 时，一次「已同步」的 `apply` 也记录 DSH 已有的声明 skill 的所有权与生效 overlay；此前什么都不记录，之后从清单删掉这类 skill 时被当作未管理，不会移除。

## 0.8.0 - 2026-10-04

### 升级须知

- `gc --yes` 现在也删除 `envctl/backups` 中早于 `--older-than`（默认 7 天）的快照，始终保留最近 10 个；`rollback` 只能回到还在的快照。需要更早的快照时，先用 `--older-than` 调大期限，或在 `gc` 前备份 `envctl/backups`。
- `--harness-source` 指向不存在的目录时以退出码 3 报错，不再改用清单的 `sourceDir` 或 PATH 上的 `dsh`；相对路径按当前目录解析。
- `source clone --profile --ref <ref>` 把该 ref 写进清单（替换原来声明的 `commit`/`ref`）；不带 `--ref` 时克隆并锁定清单已声明的 `commit` 或 `ref`，不再总是锁定默认分支的 HEAD。别名已指向另一个包时拒绝（退出码 3），默认别名去掉 `dsh-plugin-`、`dsh-` 前缀。
- 包名（含作用域）不能以 `-` 开头。
- 没有清单时 `status` 以退出码 3 结束（此前为 5）；`tools list --all --preset` 以退出码 3 拒绝。

### 修复

- `install <git 地址>#<分支或 tag>` 把 `#` 后的内容记为 `ref`，不再因「不是 commit」报 schema 错误；README 的 Git 示例改用会锁定 commit 的 `source clone --profile`。
- 包名（含作用域）不能以 `-` 开头，避免被 pnpm 当成选项。
- `source show/sync/clone` 调用 git 时不再继承 `GIT_DIR`、`GIT_WORK_TREE` 等变量；此前从 git hook 或 CI 步骤里运行时会检查、快进或锁定另一个仓库。
- `remote sync` 发现本地克隆的 origin 与 `remote.json` 的 URL 不一致（如 rollback 跨过了一次 `remote add`）时重新克隆；此前会从旧仓库取内容。
- 团队仓库中直接放在 `skills/` 下的文件（如 `README.md`、`.DS_Store`）被忽略，不再让整个提交被拒；使用教程的团队仓库布局补上 `skills/` 与 `__jsExpr` 限制。
- 有生效 overlay 时，`--layer base` 的 `enable`、`disable`、`remove` 等能改 overlay 用 `remove: true` 去掉的 base 插件；此前按合并后的清单找别名，报「not found」。
- 没有清单时 `status` 以退出码 3 结束（与 `plan` 一致），不再报告为 `degraded`（退出码 5）。
- `tools list --all` 与 `--preset` 同时使用时报错（退出码 3），不再静默忽略 `--preset`。
- 对已经全部纳管的候选执行 `adopt --yes` 时输出「Nothing to adopt」，不再报告「Adopted N plugin(s)」并列出它们。
- 写 overlay 的命令（`plugins config set`、`tools config set`、`install` 等加 `--layer overlay`）拒绝含 `${...}` 的值（退出码 3），与写 base 一致；此前会写进 overlay，之后所有读取它的命令都以退出码 3 失败，只能手改文件。
- 有生效 overlay 时，`update --layer base` 与 `plugins config set --layer base` 能改 overlay 用 `remove: true` 去掉的 base 插件，`update --layer base` 按 base 中的来源判断是否为 npm；此前前者崩溃（退出码 1），后者按 overlay 覆盖后的来源拒绝。
- overlay 里只调整某个 base 插件（没有 `package`）、而 base 已不再声明它时，`install`/`source clone --profile` 加 `--layer overlay` 写入完整的 `package`；此前输出「Added」，插件却不在生效清单中。
- `source clone --profile` 克隆并锁定清单为该别名声明的 `commit` 或 `ref`（同一仓库时），清单里保留它；给了 `--ref` 时写入该 ref。此前总是锁定默认分支的 HEAD 并删掉清单里的 `commit`/`ref`，照 `plan` 的提示操作会悄悄换掉固定的代码。
- `source clone --profile` 的别名已指向另一个包时拒绝（退出码 3，base 与 overlay 都是），与 `install` 一致；此前写 base 时整条替换、丢掉原包的 `patches` 与启用状态，写 overlay 时让清单与 lock 的包名不一致。
- `source clone` 的默认别名与 `install` 相同（去掉 `dsh-plugin-`、`dsh-` 前缀）；此前 `install` 之后按 README 再 `source clone` 会因重复包报错。
- base 已声明、但本机 DSH 从本地路径（`link:`、`file:`）安装的插件，`adopt --yes` 保留 base 中的条目，把本机路径写进 overlay（没有生效 overlay 时新建并选中 `local`）；此前会把本机路径写进共享的 base，推到团队仓库时被拒。
- 对 base 已按安装方式声明的本地来源插件再次 `adopt --yes`，保留 `lock.json` 中 apply 记录的摘要并输出「Nothing to adopt」；此前会抹掉摘要，之后 `plan` 对每个这类插件都提示更新。
- `pull` 与 `adopt` 给新插件选别名时避开当前 overlay 新增的别名；此前与 overlay 别名相同时，前者整体失败、后者被拒绝（「an overlay cannot change package」）。
- 团队 skill 里同一路径在文件与目录之间互换时，`remote sync` 能正常预览与接受（先删除再写入）；此前预览报 `EEXIST`（退出码 1），或误报该路径「not owned by the remote」（退出码 3），之后每次 sync 都失败。目录里仍有本机文件时照旧拒绝。
- 快照另存当时所有 overlay 文件；`rollback` 跨过一次 `remote add --replace` 时，把被团队接管的本机 overlay 恢复为原内容；此前会删除它。
- `apply` 删除插件后，`purge <包名>` 能清理它留在 `envctl/sources` 下的 clone（清单不再声明该包时）；此前因所有权记录已去掉而拒绝，与 `remove` 帮助所说的流程不符。
- `--harness-source` 指向不存在的目录时以退出码 3 报错；此前静默改用清单的 `sourceDir` 或 PATH 上的 `dsh`，`doctor`、`apply`、`web start` 跑的是另一个 DSH。
- `--harness-source` 的相对路径按当前目录解析；此前被解析两次（`hs/hs`），相对路径总是失败。
- 容器示例的 `.dockerignore` 排除 `envctl/run/`（`web start` 的记录，含带 token 的 dsh web 登录地址）、`remote.json`、`remote/` 与锁的 `.wanted`/`.reclaim` 文件；此前用过 `web start` 的配置仓库构建镜像时，token 会进入镜像层。
- 帮助的环境变量部分补上 `DSHENV_NPM_CHECK`；README 与使用教程中需要 `--layer` 的命令补上 `plugins config unset` 与 `tools reset`；README 说明没有快照时的 `rollback` 与没有订阅时的 `remote remove` 以退出码 3 结束。

### 变更

- `gc` 同时删除 `envctl/backups` 中早于 `--older-than` 的快照（始终保留最近 10 个），以及被中断的操作留下、超过同一期限的 `.…partial` 临时目录；此前快照只增不减，每次有变更的 `apply` 都会复制一份 `envctl/skills`。

## 0.7.0 - 2026-10-04

### 升级须知

- `install` 的别名已指向另一个包时以退出码 3 拒绝（base 与 overlay 都是），需要用 `--as` 换别名或先 `remove`；此前会静默替换。
- `lock.json` 的插件别名按清单别名的规则校验，含空白的别名会让 lock 无法加载。
- `remote add/sync` 预览末尾的提示改为 `Re-run with --ref <commit> --yes to accept this commit.`；依赖原提示文字的脚本需要调整。不带 `--ref` 的 `--yes` 行为不变。
- 命令行输出中的控制字符与双向文本控制符显示为 `\uXXXX` 转义（`--json` 输出本来就会转义，不受影响）。
- 有生效 overlay 时 `pull` 不再把 overlay 的条目并进 base；曾依赖这一行为把 overlay 内容「提升」到 base 的，请改为直接编辑 base 清单。

### 新增

- `remote add --ref <commit|tag>`：固定到订阅分支上指定的提交，而不是分支最新提交。

### 修复

- 选中 overlay 时，`pull`（以及 `adopt --yes` 随后的 pull）只把 DSH 改动的条目写进 base，overlay 删除、新增或覆盖的条目留在 overlay；此前会用合并后的结果重写 base：overlay 删掉的 base 条目被永久删除，overlay 新增与覆盖的条目被搬进 base，overlay 被清空，而 `plan` 不报告任何差异。
- `rollback` 与失败的 `apply` 恢复 `state.json` 后，去掉已不在 Profile 里的插件的所有权记录；此前会留下这类记录，之后手动装回同名插件时，下一次 `apply` 会把它当作自己拥有的插件卸载。一次无改动的 `apply` 也会清理已有的这类记录。
- 失败的 `apply` 把已经生效的步骤记为 `restart-required`，`rollback` 保留回滚前尚未处理的 `restart-required`；此前两者都整体恢复 `state.json` 中的 Profile 状态，DSH 仍在运行旧代码却不再提示重启。
- `status` 对 `state.json` 中仍为 `restart-required` 的插件如实报告，包括已移除的插件和清单声明、但 Profile 里查不到的插件（如关闭热重载时停用的内置插件）；此前显示为 `healthy`。
- 清单不再声明某个别名后（改名或删除了 dshenv 不拥有的插件），`plan` 会清理 `cordis.patch.yml` 中该别名的受管配置块与挂载块；非 bundle 插件按别名判断是否已挂载，改名后在新别名下挂载。此前旧块一直保留且 `plan` 显示无变化。
- 有生效 overlay 时，`adopt` 不再把 overlay 覆盖过的插件（如改了 `enabled` 或来源）按 DSH 实际安装的样子写进 base，这类插件视为已由 overlay 管理。
- `install` 的别名已经指向另一个包时拒绝（退出码 3），提示用 `--as`；此前写 base 时整条替换、丢掉原包的 `patches` 与启用状态并输出「Added」，写 overlay 时只改来源，把新版本混进原包的条目。
- `pull`（以及 `adopt --yes`）遇到含 `${...}` 的 DSH patch 条目时，跳过该 Profile 的 patch 并给出警告，其余 skill 与插件照常导入；此前整个命令以退出码 3 失败。
- base 声明、当前 overlay 用 `remove: true` 去掉、但仍装在 DSH 里的插件，`pull` 不再把它当作未管理插件以第二个别名加入 base（此前因重复包报错，之后每次 `pull` 都失败），改为给出警告。
- 命令行输出中的控制字符与双向文本控制符显示为 `\uXXXX` 转义；此前团队仓库里的 skill 文件名、插件别名等可以带终端控制序列，隐藏或抹掉 `remote add/sync` 预览中的行。`lock.json` 的别名改为与清单别名相同的校验。
- `remote add/sync` 的预览末尾给出带 `--ref <预览的 commit>` 的接受命令，`remote add` 新增 `--ref`；此前预览后分支有新提交时，`--yes` 接受的是未经审阅的新 commit。
- `remote add/sync --yes --json` 输出 `operationId` 与 `snapshotId`，脚本可以据此 `rollback`。
- `adopt --yes` 把本机路径插件写进 overlay 时，输出列出这些插件，并说明新建并选中了哪个 overlay；`adopt --layer overlay` 的报错与使用教程不再说 adopt 只写 base。

## 0.6.1 - 2026-10-04

### 修复

- `apply` 更新已有所有权的插件后，`state.json` 中该插件的 `lockedVersion` 与 `sourceType` 跟随清单更新（最初取得所有权的 `adoptedAt` / `adoptedBy` 保留）；此前一直停留在第一次安装或采纳时的版本。

## 0.6.0 - 2026-10-03

### 升级须知

- 清单与 overlay 中的 npm 版本按 SemVer 2.0 校验，`01.2.3`、`1.2.3-rc.01` 等带前导零的写法会以退出码 3 拒绝，需改为规范写法；`1.2.3-beta.1+build.5` 现在可以使用。
- `adopt` 遇到 `link:`、`file:` 插件时写进本机 overlay（没有选中的 overlay 时新建并选中 `local`），不再写进 base；`--no-overlay` 且未选 overlay 时拒绝。
- overlay 对 base 已不再声明的插件写的 `remove: true` 或字段覆盖不再报错，而是不起作用；拼错的别名因此不会被发现，可用 `dshenv overlay show` 核对。
- `source sync -p` 写 lock 前要求目录的 origin 是清单声明的仓库，且锁定的 commit 已推送到 origin。
- `DSH_CLI` 指向不存在的路径时退出码由 5 改为 4。

### 修复

- 有生效 overlay 时 `adopt` 不再要求 `--layer`：它只写 base，此前的报错却提示传 `--layer base` 或 `--layer overlay`，而后者对 `adopt` 无效。
- `web start` 与 `verify --start` 启动 `dsh web` 前与 `apply` 一样检查 DSH 版本，不支持的版本以退出码 4 拒绝（`--allow-untested-dsh` 或清单的 `allowUntestedVersion` 可放行）；此前会直接启动，不支持的 DSH 可能在打印 URL 后才崩溃，`web start` 却已报告 Started。
- 对不跑 `dsh web` 的 Profile（bundles 选了 `dsh-headless`、`dsh-acp-app` 或 `dsh-sdk-app`）执行 `web start` 或 `verify --start` 时直接说明原因，退出码 3，不再只转述 DSH 的 `unknown option '--no-open'`。
- `apply` 失败撤销 `cordis.patch.yml` 时，保留 DSH 在两次 dshenv 写入之间加入的条目；此前同一 Profile 先后写了两次、DSH 在中间改过该文件时，逆序撤销会把整份文件恢复到两次写入之前，DSH 的改动丢失。
- overlay 的插件别名与 base 清单一样拒绝 `__proto__`、`constructor`、`prototype`、`@profile` 和含空白的名字；此前 overlay 里写 `constructor: { enabled: false }` 不报错，改动被丢掉，还会改到全局 `Object`。别名或 Profile 名与 `toString` 等继承属性同名时，合并按新条目处理，不再误认作 base 中已有。
- `adopt` 核对候选清单是否过期时，除 npm 版本外还比对 Git 地址与锁定 commit、本地路径和来源类型，不一致时以 `Candidate is stale` 拒绝；此前 capture 之后插件在 DSH 里换了 commit 或改为本地链接安装，`adopt --yes` 仍会接受，把旧 commit 写进 lock，下一次 `apply` 会把插件降回旧版本。
- `apply --yes --verify` 一次改了多个 Profile 时不再拿 `DSHENV_DSH_URL` 逐个核对：它只指向一个 `dsh web`，此前其他 Profile 会被误判为核对出错（退出码 5），依赖碰巧相同时还会核错对象却报通过。现在只核对各 Profile 自己 `web start` 启动的那个，其余注明 `Not verified`。
- `capture`、`pull` 与 `adopt` 遇到声明为 tarball URL 或 `npm:` 别名的依赖时跳过并警告；此前未安装的 tarball 会被记成 `0.0.0`（之后 `apply` 必然失败），已安装的会被记成公共 registry 上同名包的版本，换一台机器会装成别的东西。
- `rollback` 保留 apply 放进 `DSH_HOME/skills` 的 skill 的基线（与插件所有权一样）：回滚到不含该 skill 的快照后，下一次 `apply` 会把它移进 trash；此前它变成未受管，`apply` 不再清理，`pull --yes` 还会把它当作 DSH 新增的 skill 收回清单。
- 清单与 `DSH_HOME/skills` 都有、内容不同又从未同步过的 skill，`pull` 视为两边都改过，需要 `--prefer dsh` 或 `--prefer manifest`；此前 `pull` 默认用 DSH 的副本覆盖清单里的新版本，`plan` 却说是清单改了，两边结论相反。`plan` 对这种 skill 说明 `apply` 会装清单的副本，并提示可用 `pull --yes --prefer dsh` 保留 DSH 的。
- `remote add` 与 `sync` 按整个目录判断团队 skill 与本地 skill 是否冲突：本地已有不归团队的同名 skill 时拒绝并提示先移走；此前只逐个文件比较，团队新增的文件会混进本地同名 skill，之后 `pull` 也拒绝改动它。
- 本机 overlay 对团队已删除的插件写了 `remove: true` 或字段覆盖时，`sync` 不再被拒绝：合并时对 base 已不再声明的插件，这类条目视为无操作（profile patches 一向如此）；此前只能手改 overlay 才能同步，未选中的 overlay 在同步后也无法再加载。带 `package` 的条目仍按新增插件校验。
- 本地源码与 skill 的摘要计入软链接（按指向的路径），skill 同步时软链接原样复制，整个 skill 目录本身是软链接时按目录处理；此前软链接被静默跳过：改了它的指向不算变化，`pull`/`apply` 复制后软链接丢失而两边摘要仍相同，以软链接放进 `DSH_HOME/skills` 的 skill 既不会被 `pull` 也不会列为未受管。不含软链接的目录摘要不变。
- `adopt` 接管本地来源（`link:`、`file:`）插件时与 `pull` 一致：放进本机 overlay（缺省新建并选中 `local`）并记录源码摘要，不再把本机绝对路径写进 base；此前接管后 `plan` 立即报 `Local source has no recorded digest` 要求重装。
- 回收失效的环境锁时，经同一个文件句柄读取锁的修改时间与内容，删除前核对仍是同一个文件；此前两次读取之间锁被释放并由另一进程新建时，可能按旧锁的时间删掉新锁，两个进程同时进入。
- `rollback`、`purge`、`gc` 在取得环境锁之后才选择快照、解析所有权与收集待删项；此前在加锁前决定，等锁期间其他命令的改动不会被看到。`overlay create` 也改为持有环境锁。
- `apply` 中途失败时，此前已成功的 `update`（替换 DSH 自装或来源不同的版本）也记入所有权，与成功时一致；此前只记 `install`，之后从清单删除该插件时只会标为未受管而不卸载。
- `apply` 写完 `state.json` 后追加日志失败时不再整套回滚：此时安装已完成、状态已提交，此前会撤销 bundles 与 patch 并恢复 lock/state，留下半回滚的环境并报告失败。
- `remote sync` 发现本地裸克隆缺失（如 `remote remove` 之后又 `rollback` 回订阅状态）时按订阅地址重新克隆，不再要求先 `remote remove` 再 `remote add`。
- 上一次 `sync` 被中断后，只有回滚到该次 `sync` 之前的快照才解除「先 rollback」的提示；此前任意一次 `rollback` 都会解除，文件可能仍是写了一半的状态。
- macOS 与 Windows 上判断文件是否归团队 remote 所有时不区分大小写；此前 `--overlay Team --layer overlay` 能写进团队的 `team.yaml`，直到下次 `sync` 才作为本地改动被发现。
- Git 地址带 `private_token`、`access_token`、`token`、`password` 等查询参数时与带用户信息一样拒绝，避免写进共享的清单、lock 与 `remote.json`。
- 精确版本按 SemVer 2.0 校验：接受 `1.2.3-beta.1+build.5` 这类同时带预发布与构建号的版本，拒绝 `01.2.3`、`1.2.3-rc.01` 等带前导零的写法。
- 检查 npm 上是否有该版本时，`--fetch-retries=0` 放在 `--` 之前才会生效；此前它被当作位置参数，离线时只能等超时。
- `capture` 把 Git 依赖 `#<分支或标签>` 片段记为 `ref`，不再留在 URL 里；npm 的 `#semver:` 等 Git 无法检出的片段跳过并警告。
- `source sync -p <profile> [dir]` 写 lock 前核对该目录的 origin 就是清单声明的仓库，并要求锁定的 commit 已在 origin 的某个分支上；此前会把其他仓库或未推送的 commit 写进 lock，到 `apply` 才失败。
- `DSH_CLI` 或 `--harness-source` 给出的 DSH 路径不存在时，按「未找到 DSH」以退出码 4 报告，与文档一致；此前报运行时探测失败（退出码 5）。
- `doctor` 遇到无效的清单时在 stderr 警告它忽略了清单中的 harness 设置；此前静默忽略，可能改去探测 PATH 上的另一个 DSH 而无从察觉。
- `dsh web` 打印的地址带颜色控制码时，记录的 token 不再包含控制码；此前 `verify` 会因此登录失败（401）。

## 0.5.0 - 2026-09-30

### 升级须知

- `pull` 与其他改状态的命令一致：不带 `--yes` 只预览（同 `--dry-run`，有待接管的内容时退出码 2，并在 stderr 提示加 `--yes`），脚本里的 `dshenv pull` 需改为 `dshenv pull --yes`。`plan` 等输出里的提示相应改为 `run 'dshenv pull --yes'`。
- `state.json` 的结构不兼容 0.4.x（`apiVersion` 仍为 `dshenv-state/v1`）：顶层的插件所有权 `ownership` 与 skill 基线 `skills` 移到 `resources` 下，新版本不读旧结构，遇到会报 `Invalid state schema: : Unrecognized keys: "ownership", "skills"` 并以退出码 3 退出，`rollback` 到升级前的快照也会因此失败。升级后先把 `envctl/state.json` 手工改成新结构：
  - `"ownership": { <profile>: { <包名>: {…} } }` 改为 `"resources": { "plugin": { <profile>: { <包名>: {…} } } }`，记录内容不变；
  - `"skills": { <名字>: "<摘要>" }` 改为 `"resources": { "skill": { <名字>: { "digest": "<摘要>" } } }`；
  - 两者都有时合在同一个 `resources` 里。改完运行 `dshenv status` 确认能读取。

### 新增

- `apply -p <profile>`：与 `plan -p` 一样只应用一个 Profile 的插件与 profile patch，其他 Profile 的所有权与重启记录不变；skill 不属于任何 Profile，照常应用。此前 `apply -p` 报 `unknown option`，只能整体应用。
- `tools config get|set|unset`：与 `plugins config` 写法一致，并可删掉工具配置里的一个键；旧写法 `tools config <tool> [路径] [值]` 仍可使用，不再出现在帮助里。
- 所有要 `--yes` 的命令都接受 `--dry-run`（新增到 `adopt`、`remote add|remove|sync`），与 `--yes` 同时出现时只预览；`self-update --dry-run` 同 `--check`。
- `apply --yes --verify`：应用之后核对每个有改动的 Profile 在运行中的 `dsh web` 里是否真的加载了（与 `verify` 相同的检查），热加载中的插件最多等 `--verify-timeout` 秒（默认 30）；退出码与 `verify` 相同，没有运行中的 `dsh web` 时注明未核对。

### 变更

- 命令按"动作 + 资源"整理，旧名仍可使用、不再出现在帮助里：
  - 插件命令也可写在 `plugins` 下：`plugins install|update|remove|enable|disable|list|config`；顶层的 `list`、`config` 由 `plugins list`、`plugins config` 代替，`install` 等五个仍在顶层；
  - `runtime` 改名为 `verify`，与 `apply --verify` 对应；
  - `source pull` 改名为 `source sync`，与 `remote sync` 一样表示"从上游 Git 取"，不再与 `pull`（DSH -> 清单）同名；
  - 帮助分组改为 `Plugins & tools`（含 `source`）、`Run & check`（`web`、`verify`、`doctor`），`rollback` 移到 `Maintenance`；`plan`、`apply`、`status`、`doctor`、`init`、`capture`、`adopt` 的说明改为以动作开头并写明各自检查什么，`remove` 的说明提到 `purge`；根帮助的示例补上 `pull`、`verify`、`remote add`。
  - `adopt` 的候选文件改为位置参数：`dshenv adopt capture.yaml --yes`；`-f`/`--from` 仍可使用，不再出现在帮助里。
  - 错误提示与文档一并改用新名，例如团队 lock 固定的条目提示 `run dshenv remote sync`，不再是有歧义的 `dshenv sync`。
- `update --to` 用在 Git 或本地来源的插件上时，报错说明该用什么：Git 插件用 `dshenv source sync -p <profile> --as <alias>`，本地来源的改动由 `plan`/`apply` 自动跟上。
- `state.json` 按资源类型记录 dshenv 拥有的资源（`resources.plugin`、`resources.skill`，见「升级须知」），为插件、profile patch、skill 统一生命周期做准备；命令的输出与行为不变。

### 修复

- `verify`（原 `runtime`）把清单里 disabled、但被 profile patch 条目（如自己写的 insert 分组）加载的非 bundle 插件一直报成 `loading (unmounted on disk; waiting for DSH to hot-reload it)`、退出码 2；现在按应当加载检查，正常时报 `loaded … (mounted by a profile patch entry, not by dshenv)`、退出码 0，加载失败或挂起仍如实报告。

## 0.4.1 - 2026-09-30

### 变更

- 本地来源插件的摘要：`package.json` 有 `files` 时只算 npm 会发布的文件，改 docs、测试、图片等不再让 `plan` 报更新、`apply` 要求重启。升级后，有 `files` 的本地插件会各出现一次 `Local source changed`，`apply --yes` 记下新摘要即可；没有 `files` 的包与 skill 不受影响。

### 修复

- `source pull` 不给 `--ref` 时一律以退出码 3 拒绝，与 README 的示例不符；现在默认快进到当前分支对应的远端分支，处于 detached HEAD 时才要求 `--ref`。
- 用 `install` 声明一个 DSH 里已经装着的插件、再由 `apply` 更新到声明的版本或来源时，没有记下所有权，之后 `remove` 加 `apply` 不会卸载它（`plan` 只把它列为 unmanaged 并报告已同步），`purge` 也拒绝处理；现在 `apply` 的 update 与 install 一样记下所有权。
- 生效 overlay 已经声明的插件出现在 capture 文件里时，`adopt` 预览报 `an overlay cannot change package`；现在视为已接管，不写进 base，也不在 base 里留下空的 Profile。
- README 写明 `status` 的退出码与 `plan` 相同（有待执行的变更时为 2）。

## 0.4.0 - 2026-09-30

### 升级须知

脚本里用到下面几处时需要调整，详见「变更」：

- 改状态的命令不带 `--yes` 时只预览：有待执行内容时退出码 2，此前多数是报错退出码 3（见「变更」里的退出码对照表）。
- `overlay: <name> (file)` 提示行从 stdout 改到 stderr。
- 过滤类命令的 `-p` 写了不存在的 Profile 时退出码 3，此前报“已同步”、退出码 0；`install`/`update --to` 会先用 npm 核对版本（`--no-npm-check` 或 `DSHENV_NPM_CHECK=off` 跳过）。
- `web status`、`source status` 改名 `web list`、`source show`，旧名仍可用。

### 新增

- `dshenv pull` 接管 `plan` 列为 `Unmanaged plugins` 的插件：描述方式与 `capture` 相同，lock 与所有权按 `adopt` 记录（`local-link` 另记源码 digest），接管后 `plan` 没有待执行操作；`local-link`/`local-file` 插件写进本机 overlay（没有选中时新建并选中 `local`，`--no-overlay` 时拒绝），其余写进基础清单。`--json` 输出新增 `plugins` 与 `warnings`；`plan` 的未管理插件提示改为指向 `dshenv pull`。此前只能 `capture` + `adopt`（只写基础清单），或 `install <path> --layer overlay` 再 `disable`。
- `-p, --profile` 的统一规则：作用于单个 Profile 的命令（`install`、`update`、`enable`、`disable`、`remove`、`purge`、`config`、`tools`、`runtime`、`web start`、`web stop`）不写 `-p` 时使用环境变量 `DSHENV_PROFILE`；两者都没有时以退出码 3 报 `Missing -p, --profile <name>: choose one of …, or set DSHENV_PROFILE`，列出清单声明的与 DSH 已创建的 Profile（此前是 commander 的 `required option ... not specified`，退出码 1）。`DSHENV_PROFILE` 不合法时报错并注明来源。
- `web list -p <name>` 只列出一个 Profile；`capture` 支持 `-p` 简写。
- `tools reset <tool>`：删掉清单里改动该工具的 patch，恢复 DSH 的默认；预设内的工具会连同整个预设一起解除固定。
- `config unset <alias> <dottedPath>`：从插件配置 patch 里删掉一个键（删空的父级一并删除）；overlay 只能删它自己设置的键。
- `--new-profile`（`install`、`new -p`、`source clone -p`）：写入一个清单没声明、DSH 也没创建的 Profile 时须显式加上，防止拼错的名字悄悄建出新 Profile。
- `DSHENV_LAYER`：有生效 overlay 时作为改清单命令 `--layer` 的默认值；没有 overlay 时，`DSHENV_LAYER=overlay` 与 `--layer overlay` 一样以退出码 3 拒绝（改动不会落进团队共享的 base），其他值（包括不合法的值）不起作用。取自 `DSHENV_PROFILE` 或 `DSHENV_LAYER` 的值会在 stderr 提示一行（`--json` 时不提示）。
- `config set --force`：DSH 为该插件组合出了配置而其中没有这个顶层键时，`config set` 在 stderr 提示一行并给出相近的键名，照常写入（DSH 只组合出带默认值的键，插件文档里的合法键可能不在其中）；`--force` 不再提示。
- `plan -p <name>`、`status -p <name>` 只看一个 Profile；`status` 文本输出列出每个插件的状态，`status <alias>` 只列出该插件（此前只有 `--json` 生效），`Profiles monitored` 计入清单声明但尚未创建的 Profile。
- `dshenv remote sync`：即原来的顶层 `sync`。
- `dshenv overlay create <name>`：新建只含 `apiVersion` 的空 overlay，文件已存在时退出码 3。README 补上 overlay 文件格式示例。
- 顶层帮助按用途分组（Getting started、Everyday、Plugins、Tools & web、Checks、Team & machine、Authoring、Maintenance：`mark-restarted` 挨着 `status`，`doctor` 与 `runtime` 同属检查，`purge` 与 `gc` 同属清理），附常用示例、数据流向与环境变量说明；子命令帮助列出全局选项；`dshenv` 不带参数时显示帮助并退出码 0。

### 变更

- README 新增「确认执行（`--yes`）」一节：只改 envctl 声明的命令直接写入，会改 DSH、批量接管或覆盖文件的命令（`apply`、`adopt`、`rollback`、`gc`、`purge`、`remote add|sync|remove`）不加 `--yes` 只预览并以退出码 2 结束；`remote add|sync` 的 `--yes` 帮助补上 `without it … only previews`。
- 按 Profile 过滤的命令（`list`、`plan`、`status`、`pull`、`capture`、`overlay show`、`mark-restarted`、`web list`）的 `-p` 说明统一为 `only this profile (default: all)`，它们不读 `DSHENV_PROFILE`；`-p` 写了清单没声明、DSH 也没创建的名字时以退出码 3 拒绝并给出相近的名字（此前 `plan -p <拼错>` 报 in sync、退出码 0，CI 靠退出码判断漂移会被放过）；必填的一律为 `target profile (default: $DSHENV_PROFILE)`。
- `runtime` 在清单声明多个 Profile 又没指定时，报错改为同一格式并列出可选的 Profile。
- `config get <alias> [dottedPath]` 用位置参数读取嵌套字段，与 `config set`、`tools config` 一致；`--path` 仍然可用，但不再出现在帮助里。
- `source pull` 的 ref 只在帮助里保留 `--ref`（与 `source clone` 一致）；第二个位置参数仍然可用。
- `purge`、`status` 的参数在帮助里改名为 `<alias>`（接受别名或包名，行为不变）。
- 查看类子命令统一动词：列出多个用 `list`，查看一个用 `show`。`web status` 改名 `web list`，`source status` 改名 `source show`，旧名作为别名保留（不出现在帮助里）；`source` 各子命令的目录参数统一叫 `[dir]`。
- `rollback` 的说明写明它只恢复 envctl 文件（清单、lock、overlay），恢复后提示 `DSH itself is unchanged. Next: dshenv plan, then dshenv apply --yes.`；`purge` 的说明改为 `Move a plugin's managed config patch and envctl/sources clone into trash (gc empties it)`。
- `install`、`update`、`enable`、`disable`、`remove`、`config set`、`tools enable|disable|config` 的输出说明只改了清单并给出下一步：如 `Added … to profile 'web' in the manifest. Next: dshenv plan, then dshenv apply --yes.`；同一别名重新 `install` 换了版本时说 `Changed agent-teams in profile 'web' from 0.1.20 to 0.1.21`。`--json` 输出不变。
- `install` 与 `update --to` 的 npm 版本先用 `npm view` 核对：包在而版本不存在时以退出码 3 报错并给出最新版本（npm 10 对不存在的版本也回 E404，会再查一次包来区分）。npm 看不到这个包（可能是需要凭据的私有包）、拒绝凭据，或查询不了（离线，约 5 秒超时，超时连同 npm 启动的子进程一起结束）时只警告、照常写入。加 `--no-npm-check` 或设 `DSHENV_NPM_CHECK=off` 跳过；`--json` 输出新增 `npmCheck`（`verified`、`unverified`、`unreachable`、`skipped`）。包名不合法（如以 `-` 开头）时直接拒绝，`npm view` 的参数前也加了 `--`。
- `config get|set|unset` 的路径为空，或含 `__proto__`、`prototype`、`constructor` 时以退出码 3 拒绝；读取和删除只认配置里自己的键，不再读到或删掉 `toString` 这类继承属性（此前 `config unset <alias> __proto__.toString` 会改到进程内的对象原型）。
- `config unset` 在该插件声明的所有 patch 里找这个键，base 与 overlay 一致；删完后什么都不设的 patch 一并删掉，不留下 `config: {}`。
- `tools enable|disable|config` 只接受 `tools list --all` 列出的工具 id，其他 id（如 DSH 的 web 能力层 `web`）以退出码 3 拒绝并给出相近的 id；有生效的 overlay 时也先检查 id，再要求选择 `--layer`。
- 插件别名写错时报错给出相近的别名，也接受包名；插件只在 overlay 里却写 base 时，提示改用 `--layer overlay`；Profile 未声明时直接说明，而不是说找不到插件。
- 需要 DSH 已创建 Profile 的命令（`tools`、`web start`、`runtime --start`）：Profile 已声明时仍提示先用 `--profile` 启动 DSH 一次；未声明时列出已知 Profile 和相近的名字，不再引导去创建拼错的 Profile。
- `runtime`：`DSHENV_PROFILE` 指向未声明的 Profile 时报错注明来源；缺 `-p` 时只列出清单声明的 Profile；清单没有 Profile 时仍报 `The manifest declares no profiles`。
- `config get` 同时给位置参数和 `--path`、`source pull` 同时给位置 ref 和 `--ref` 时以退出码 3 报冲突；`config get` 读不存在的键时以退出码 3 报错（`--json` 下是标准错误 JSON，不再输出 `undefined`）。
- 缺 `-p` 时列出的 Profile 读不到清单或 overlay 时，直接报出真实错误，不再说 `no profile exists yet`。
- `adopt --help` 不再显示 `--layer`（它只写 base，传入 `--layer base` 仍可用）。
- **退出码**：改状态的命令不带 `--yes` 时一律只预览，有待执行的内容时退出码 2（与 `plan` 相同），没有时退出码 0；`--dry-run` 同样有变更时退出码 2。

  | 命令 | 之前 | 现在 |
  | --- | --- | --- |
  | `apply`（不带 `--yes`） | 拒绝，退出码 3 | 预览，有变更 2 / 无变更 0 |
  | `apply --dry-run` | 0 | 有变更 2 / 无变更 0（有 blocked 时 5，与 `plan` 相同） |
  | `rollback`（不带 `--yes`）、`rollback --dry-run` | 拒绝 3 / 0 | 预览，找到快照时 2 |
  | `gc`、`purge`（不带 `--yes`）及其 `--dry-run` | 拒绝 3 / 0 | 预览，有可删除或移动的内容时 2，否则 0 |
  | `adopt`（不带 `--yes`） | 直接写入，0 | 只列出将接管的插件，有插件时 2，不写文件 |
  | `remote remove`（不带 `--yes`） | 拒绝，3 | 预览，2 |
  | 用法错误：缺参数、未知选项或命令、缺必填选项 | 1，`--json` 时仍是纯文本 | 3，`--json` 时输出 `{"error": {"type": "ValidationError", ...}}` |
- `restarted` 改名为 `mark-restarted`，`apply` 与 `runtime` 的提示改为 `dshenv mark-restarted`；旧名仍可用，只是不再列在帮助里。顶层 `sync` 同样保留为 `remote sync` 的隐藏旧名；`uninstall` 是 `remove` 的隐藏别名。
- `list` 的文本输出改为带表头的表格（`PROFILE ALIAS PACKAGE VERSION ENABLED INSTALLED`，有生效 overlay 时加 `ORIGIN`），显示启用状态；`--json` 的每行多了 `version`。没有插件时 `list`、`overlay list` 提示如何添加。
- `remove` 的 `-y` 不再出现在帮助里（它只改清单，没有需要确认的内容），旧脚本仍可传；`update --to`、`adopt -f` 在帮助里标明必填；`config get/set/validate` 补上说明。
- 不带 id 的 `rollback` 跳过失败的 `apply` 留下的快照（它们已经自己恢复过，恢复它们什么也不会改变），恢复到最近一次真正改动过文件的操作之前，输出写明恢复的是哪次操作之前的状态、跳过了哪些。
- `apply` 的快照包含当时生效的 overlay 文件，回滚到它会连同用 `--layer overlay` 改过的 overlay 一起恢复。
- `apply` 某一步失败时，错误信息写明失败的步骤（`[web] install cc (cc), step 2 of 2`）、本次 operation id、仍留在 Profile 里的已装插件，以及回到上一次成功 apply 所用清单的命令 `dshenv rollback <id> --yes`。
- DSH 版本不受支持时，`doctor` 与 `apply` 报出检测到的版本（只显示数字部分，prerelease 标签可能带凭据，显示为 `-*`）、支持的版本，并提示 `DSH_CLI` 与 `--allow-untested-dsh`；`apply --dry-run` 也做同样的版本检查（无法询问 DSH 时仍显示计划）。
- DSH 创建 Profile 时自带的 bundle（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-acp-app`、`dsh-sdk-app`）没有写进清单时不再算作 `unmanaged`，新环境不会一上来就显示 `Environment Status: unmanaged`。
- 缺少清单时，所有需要清单的命令都提示 `run dshenv init to start one, or dshenv capture … then dshenv adopt …`；`status` 在 stderr 给出同样的提示。`init` 成功后给出下一步，重复 `init` 报 `dshenv is already initialized`；`adopt` 没有可接管的插件时说 `Nothing to adopt`，并以 `Next: dshenv plan` 结尾。
- `apply --dry-run` 不再重复打印 `Planned operations:` 标题；`apply --yes` 成功后标题改为 `Applied operations:`。
- `runtime` 对已加载但仍记为需要重启的插件，提示改为 `if DSH restarted after the last apply, run dshenv mark-restarted to clear the restart flag`，不再同时显示 loaded 与“重启 DSH”。
- 生效 overlay 的提示行 `overlay: <name> (file)` 从 stdout 改到 stderr，`list`、`plan`、`status`、`doctor`、`overlay show`、`apply` 的 stdout 只剩结果本身，便于脚本解析。
- `DSHENV_PROFILE` 的 stderr 提示只在写入类命令（有 `--layer` 或 `--yes` 的命令）上出现，`config get`、`tools list`、`runtime`、`web start` 等只读命令不再提示。
- `web start`、`web stop` 与 `runtime` 一样：没有 `-p` 也没有 `DSHENV_PROFILE` 时，使用清单里唯一声明的 Profile。
- `plan` 有待执行的变更时在 stderr 提示 `Next: dshenv apply --yes`；各命令的 `--dry-run` 预览有待执行的内容时提示去掉 `--dry-run` 并加 `--yes` 再运行。
- `dshenv --json`、`dshenv config` 等不带子命令运行时，把帮助打印到 stdout 并以退出码 0 结束，不再输出 `{"error":{"message":"(outputHelp)"}}`、退出码 3。
- DSH 版本不受支持的报错把预发布版本显示为 `0.1.5 (a prerelease)`，不再是像版本范围的 `0.1.5-*`。

### 修复

- `rollback` 恢复快照里的 overlay 前，把它要覆盖的 overlay 一并存进 pre-rollback 快照：apply 之后用 `--layer overlay` 做的改动不再被静默覆盖，`rollback <pre-rollback id>` 能找回来。输出改为说明恢复的是哪次操作开始时保存的文件（apply 的快照是它所应用的清单，加上它运行前的 `lock.json` 和 `state.json`），不再写成 "as they were before apply-X"。
- `apply` 在建快照、写 journal 之前检查 DSH 命令和版本：版本不受支持或找不到 DSH 时，不再留下一个会被 `rollback` 选中的快照。
- 失败 apply 的恢复提示里，查找上一次成功 apply 出错时不再误报“恢复 lock.json 和 state.json 也失败了”；提示写明回到那次 apply 的清单会丢掉之后对清单的所有改动。
- `tools reset --layer overlay` 再执行一次时，不再删掉上次写下的 `remove: true` 墓碑（那会让 base 的 patch 重新生效，输出却说 Removed），而是报 nothing to reset；没有可重置的内容时也不再往 overlay 写一个空的 Profile。overlay 里只有墓碑时，base 层 reset 不再被拒。
- `tools config <tool> <不存在的键>` 与 `config get` 一致：以退出码 3 报错并给出相近的键，不再输出 `null`、退出码 0。
- 有生效 overlay 时，`enable`/`disable --layer base` 改的值被 overlay 覆盖，在 stderr 提示这台机器上实际状态没变（`--json` 时不提示）。
- Windows 上探测 DSH 源码插件管理器的 `package.json` 时，用 BigInt 比对文件身份：64 位文件 ID 转成普通数字会丢精度，两个接连创建的文件可能被当成同一个，导致路径检查后被换成软链接的清单没有被识别。
- `adopt` 预览在候选里的插件都已接管时输出 `Nothing to adopt: every plugin in the candidate is already adopted.`、退出码 0，不再以退出码 2 反复报待接管；候选没有插件时不再输出行尾为空的 `Would adopt 0 plugin(s) across profile(s): `。
- 对已声明为同一来源的插件重复 `install`、对已启用或已禁用的插件重复 `enable`、`disable`，输出 `… already …; nothing changed.`，不再写成 `Added`、`Disabled`；清单也不改动。`--json` 多一个 `unchanged: true`。
- `source --help` 不再列出已不推荐的位置参数 `[targetRef]`（仍然可用）。

## 0.3.1 - 2026-09-29

### 新增

- `dshenv web start|stop|status`：在后台启动 dsh web（Linux/macOS 上为独立进程组，Windows 上不附着在启动它的控制台上，dshenv 退出或关闭终端后继续运行）并打印浏览器地址，停止时连同它启动的子进程一起停止；地址、pid 与主进程启动时间记在权限为 `0600` 的 `envctl/run/<profile>.json`，`runtime` 在没有设置 `DSHENV_DSH_URL` 时自动使用它。
  - 按 pid 与启动时间识别自己启动的 dsh web，不受 `COLUMNS` 截断 `ps` 输出、系统没有 `ps` 或 pid 被复用的影响；无法确认时 `status` 显示 `unknown`，`start`/`stop` 报错并保留记录，不停止任何进程。
  - dsh web 退出而它启动的子进程还在时，`status` 显示 `not running (leftover processes)`，`start` 先停掉这些子进程再启动，`stop` 也会停掉它们。
  - SIGKILL 后仍未停下时 `stop` 以非零退出码报错并保留记录；同一 Profile 的 `start`/`stop` 依次执行；启动中按 Ctrl+C 会停止正在启动的 dsh web。
  - 启动失败时引用的 DSH 输出里 `token=` 之后的内容替换为 `<redacted>`；Windows 上可以运行 npm 安装的 `dsh.cmd`。
- `dshenv runtime --start`：没有在运行的 `dsh web` 时自己启动一个（随机端口、不开浏览器、不打印 token），核对完即停止它和它启动的子进程（核对中按 Ctrl+C 也一样）；不带 web 应用的 Profile 报出 DSH 自己的错误。

### 变更

- Profile 名在清单、overlay、lock 与 `-p` 中统一校验：只能含字母、数字、`.`、`_`、`-`，不能以 `-` 开头，也不能是 `.` 或 `..`，否则报 `Invalid profile name`（退出码 3）。
- 团队配置（remote 的 manifest 与 overlay）不能再设置 `environment.harness.sourceDir` / `environment.sourceRoot`，团队 manifest、overlay 与 lock 中的 Git 插件不能使用 `file://`、绝对或相对路径等本机地址，否则整个 commit 被拒绝；这两项请写进本机 overlay。
- 团队配置（remote 的 manifest 与 overlay）的插件 patch 与 profile patch 不能含 JavaScript 表达式（`__jsExpr`），它会被写成 DSH 执行的 `!!js` 值；这类 patch 请写进本机 overlay。
- 清单中 Git 来源的 URL 与 ref 不能以 `-` 开头，`commit` 必须是 7-64 位十六进制 commit id；`source clone` 把 URL 放在 `--` 之后传给 git，`source pull --ref` 拒绝以 `-` 开头的 ref。
- `runtime --allow-remote` 连非本机地址时只接受 https，拒绝明文 http。
- `self-update` 在用户主目录下运行 npm/pnpm，不再读取当前目录的 `.npmrc`。
- `apply` 失败时只恢复它自己写的 `lock.json` 与 `state.json`，不再用快照覆盖 `manifest.yaml`、overlay 与 `envctl/skills`，apply 期间的手工修改得以保留；快照恢复本身失败时报出原因并提示 `dshenv rollback <id> --yes`，不再静默忽略。
- `apply` 遵守清单中的 `environment.harness.allowUntestedVersion`，与 `doctor` 一致。
- 从源码目录运行 DSH（`--harness-source` 或 `environment.harness.sourceDir`）改为 `pnpm --silent --dir <目录> dsh`。

### 修复

- `apply` 每装成功一个插件就记入所有权，中途失败或被中断时已装的插件不再变成未受管；`rollback` 保留由 `apply` 安装、仍在 Profile 中的插件的所有权。
- `apply` 被 Ctrl-C、`SIGTERM` 或 `SIGHUP` 中断时，先结束正在运行的 DSH 插件命令，撤销本次改动并恢复 `lock.json` 与 `state.json`，释放 `dshenv.lock` 和被结束的 DSH 留下的 `package.json.lock`，再按原信号退出；此前中断会跳过回滚，并可能留下需要手工删除的 Profile 锁。等待期间再按一次 Ctrl-C 立即退出。插件命令超时被结束时同样会释放它留下的 Profile 锁。
- 同一 Profile 内先执行卸载再执行安装，同一别名换成另一个包时，卸载旧包不再清掉新包刚写入的 patch 与挂载。
- Profile 中只出现在 bundle 列表、没有安装的包，按清单声明的 npm、Git 或本地来源安装，不再被当作已同步。
- 不存在且本次计划也不会创建的 Profile，其中的 in-box 插件操作在 `plan` 阶段标为 blocked，不再到 `apply` 建完快照后才报错。
- 替换 loose skill 失败时删除残留的临时副本，新副本改名失败时把旧技能放回原处。
- `adopt` 捕获到的别名已被另一个包占用时改用 `<别名>-1` 等新别名，不再覆盖已有条目和它的 patches。
- `gc --older-than` 只接受非负数，`''`、`-1`、`1e3` 等以退出码 3 拒绝，不再删除全部 trash。
- `purge` 先检查 patch 文件与 clone 路径都安全再改动，移动 clone 失败时恢复已清除的 patch 块。
- `source clone --profile` 写 lock 失败时恢复清单（或 overlay）并删除克隆；`source pull --profile` 总是按清单中的 URL 写入完整的 lock 条目，不再显示 `Updated` 却没有锁定新 commit。
- 从源码目录运行 DSH 时，`--version`（10 秒）与 `--dump-config`（15 秒）超时会结束整棵进程树并返回，不再被 pnpm 启动的子进程拖住；pnpm 的脚本横幅不再混进输出，`tools` 能解析、HMR 探测不再总是 unknown。
- 结束进程树时等全部退出后才返回，强制结束只发给仍存活的进程，不会误杀之后复用了 pid 的进程。
- `rollback` 先检查快照中的 `manifest.yaml`、`lock.json`、`state.json` 能否解析，不能时以退出码 3 拒绝且不改动任何文件，不再恢复出一份让之后所有命令都失败的文件。
- `adopt` 已写入清单、接管 patch 条目时失败，错误信息说明插件已接管、修正后运行 `dshenv pull` 即可，不再看起来像 adopt 没有生效。
- `remote sync` 预览复制技能目录时跳过软链接，不再顺着链接写入或删除外部文件。
- Windows 上两条 dshenv 命令同时修改清单时，另一条命令正读着清单或锁文件会让替换清单、创建锁文件失败（`EPERM`），其中一条命令以退出码 1 失败；现在会短暂重试直到对方关闭文件。
- Windows 上替换或移走技能目录、生成快照、`purge` 移走 clone、`source clone` 移入受管目录时，目录里有文件正被打开（例如 DSH 正在读技能）会以 `EPERM` 失败；这些移动现在也会短暂重试。
- 多条命令争用同一把锁时，刚释放锁的命令可以立即再次拿到，等待方按固定 100ms 轮询，偶尔一直等到超时；现在等待方以带随机抖动的短间隔重试，刚释放锁的命令发现有人在等时先让一次。

## 0.3.0 - 2026-09-28

### 新增

- `dshenv install in-box:<包名>`：把随 DSH 发布的 bundle（如 `@deepseek-ai/dsh-acp-app`）声明进清单，不再只能靠 `capture` 生成。
- `dshenv tools list|enable|disable|config`：按架构图分类列出 Profile 的内置工具与开关状态（读自 `dsh --dump-config`），开关或配置结果写进清单的 profile patches；agent 预设里的工具通过整份复制预设实现，`plan` 列出已固定的预设。
- DSH 配置双向同步：清单新增 `profiles.<profile>.patches`，原样保存 Profile 自己的 cordis patch 条目（模型、语言、权限、技能目录等），`apply` 把它们写进 `cordis.patch.yml` 的一个受管块。
- `dshenv pull`：把 DSH 写在受管块之外的条目和在受管块里的改动收进清单，含本机绝对路径的条目写进本机 overlay（没有时新建并选中 `local`），基础清单归团队 remote 所有时全部写进 overlay。两边都改过时需 `--prefer dsh|manifest`；先建快照，可用 `rollback` 撤销。
- `plan` 列出受管块之外的 patch 条目，并能分辨受管块是在 DSH 里改过还是清单改过；`adopt` 接管 Profile 时一并收进这些条目，`capture` 给出提示。
- loose skill 同步：`$DSH_HOME/skills` 下的技能目录由 `pull` 收进 `envctl/skills/<名字>`，`apply` 复制回 DSH，被覆盖或删除的副本移进 `envctl/trash`；`plan` 列出技能变更与未受管技能；快照与 `rollback` 覆盖 `envctl/skills`；团队配置仓库的 `envctl/skills` 随 `sync` 同步，`sync`/`remote add` 的预览计划包含接受后的技能变更；团队技能在 DSH 里改过时 `plan` 提示去团队仓库改或 `apply` 还原。

### 修复

- 不是 DSH bundle 的插件包（没有 `dsh.bundle`）以前被放进 bundle 列表，DSH 跳过不加载，`plan` 却显示已同步；现在改为用受管的 `insert` 行挂载，同一次 `apply` 内装好并挂载，`enable`/`disable`/`remove` 与 `runtime` 都按挂载判断。

## 0.2.1 - 2026-09-28

### 新增

- `dshenv self-update`：用 `npm view --prefer-online` 查询 npm 上的版本，再用安装 dshenv 的包管理器（全局 npm 或 pnpm）升级自身，安装输出直接显示在终端。`--check` 只查询，有可安装版本时退出码 2；`--to <版本>` 指定精确版本，可用于降级。不带 `--to` 时不会降级预发布版或本地构建。本地链接、源码检出和从 Git 地址安装的 dshenv 不会被替换。失败时只显示错误码，不带出 registry 地址或 token。
- README 与使用教程补充升级 dshenv 的说明。

## 0.2.0 - 2026-09-28

### 修复

- 快照先写入临时目录，完整后再改名发布；复制中途失败不再留下不完整的快照，避免 `rollback` 选中它并删除现有的 lock/state 文件。
- 快照记录当时不存在的 overlay；`sync` 在写入新 overlay 后、更新 `remote.json` 前被中断时，`rollback` 会删除这些新文件。rollback 前的备份会同时保存这些文件，它们若已成为本地文件，可以再次 rollback 找回。
- `source clone --profile` 在拿到环境锁之后才判断哪些目录归自己；两个 clone 并发时，失败的一方不再删掉整个 `sources/` 目录。命令失败时只删除自己的 checkout，父目录只在为空时删除。
- `source clone --profile` 先解析 `lock.json` 再写清单；lock 损坏时清单保持不变。
- `adopt` 在写 `state.json` 失败时把已写的清单和 lock 恢复原样。
- 回滚 `cordis.patch.yml` 所用的原内容在写入时的同一次 profile 锁内读取；dshenv 等锁期间 DSH 做的修改不再被回滚覆盖。
- `cordis.patch.yml` 为非空 flow 数组（如 `[{id: x}]`）时，先改写成块式序列再追加受管块，不再生成非法 YAML；`~`、`null` 等空文档按空数组处理；被旧版本写坏的文件（flow 数组后接受管块）会被 `plan` 发现并规划一次 configure，`apply` 时修复，保留所有受管块；写入结果不是单个顶层数组时拒绝写入。
- `apply` 新安装的插件会记录所有权，之后从清单删除该插件时会被卸载，不再变成未受管。
- 更新一个保持禁用的插件时，更新后会再次禁用（DSH `plugin add` 会选中 bundle）。
- 本地来源路径改变时规划 update，即使新旧路径内容 digest 相同。
- 缺少校验证据时不再报告已收敛：已装 Git 规格未指向 commit（如 `#main`）、npm 包没有版本号时按锁定版本重装；已安装的本地来源无法读取时列为 unverified：`status` 显示 degraded，`plan` 单独列出，但不阻止其他操作。
- `apply` 调用的 DSH `plugin add` / `plugin remove` 10 分钟超时，超时后终止 DSH 及其启动的 pnpm 等整棵进程树并回滚，不再无限期占用环境锁。
- 不支持硬链接的文件系统上，只创建（create-only）写入改用排他复制，不会覆盖并发创建的文件；复制中途失败时删除写了一半的目标文件。
- 在 Windows 上按 `;` 切分 PATH 并按 PATHEXT 查找 `dsh.cmd` 等命令。

### 变更

- 清单中 npm 来源的 `registry` 字段不再被接受：`apply` 从未使用它，声明私有 registry 实际会从默认 registry 安装同名包。
- `lock.json` 中的 git `commit` 必须是 7-64 位十六进制 commit id（支持 SHA-256 仓库）；分支名、tag 会被拒绝。

## 0.1.3 - 2026-09-28

### 变更

- GitHub 仓库改名为 [`costa92/dshenv`](https://github.com/costa92/dshenv)，与 npm 包名一致；npm 包的 `repository` 与 `homepage` 指向新地址。旧地址 `costa92/dsh-envctl` 由 GitHub 自动跳转。

## 0.1.2 - 2026-09-28

### 修复

- 以 `git+` 地址安装 Git 来源：`file://` 与自建服务器的 `https://` 地址此前会被 pnpm 当作本地目录或压缩包而安装失败。
- DSH 插件命令失败时显示 DSH 自己的 `dsh:` 诊断行（如版本不兼容的原因与放行命令），不再只有退出码；pnpm 原始输出不显示。
- `adopt` 替换清单中已有的插件时保留已声明的 `patches`，不再静默丢失配置。
- `status <插件>` 可以按别名过滤，与其他插件命令一致。
- `source pull --ref <分支名>` 快进到上游分支；此前会快进到本地分支自身，报告成功但没有更新。只有与上游分支完全同名时才改用上游，`HEAD`、`HEAD~1` 等修订仍按当前检出解析。

## 0.1.1 - 2026-09-28

### 变更

- 发布到 npm registry，包名 `@costa92/dshenv`（无作用域的 `dshenv` 被 npm 以与 dotenv、osenv 过于相似为由拒绝）：`npm install -g @costa92/dshenv`。命令名仍为 `dshenv`。
- 从 Git 地址用 pnpm 安装时，放行参数改为 `--allow-build=@costa92/dshenv`；卸载改为 `pnpm remove --global @costa92/dshenv`。
- Release 工作流把同一份 `.tgz` 发布到 npm（带 provenance）并附在 GitHub Release 上。

## 0.1.0 - 2026-09-27

首个公开版本。支持的 DSH 版本族：`0.1.7`（含预发布版）。

### 新增

- 环境探测与盘点：`doctor` 报告 DSH 版本与能力矩阵；`capture` 把现有 Profile 盘点为候选清单，`adopt` 建立所有权。
- 声明式管理：`manifest.yaml` + `lock.json`，`plan` / `status` 计算漂移；npm 只接受精确版本，Git 来源锁定 commit，本地来源记录 digest。
- `apply`：通过 DSH CLI 执行 install / update / remove，通过 Profile bundles 执行 enable / disable，通过 `cordis.patch.yml` 受管块执行 configure；带环境锁、快照、操作日志与失败回滚，并按 DSH 热加载状态报告哪些改动需要重启。
- 便捷命令：`install`、`update --to`、`enable`、`disable`、`remove`、`list`、`config get|set|validate`、`source status|clone|pull`、`restarted`、`rollback`、`gc`、`purge`。
- Base + Overlay 清单合并与本机 overlay 选择。
- 团队共享基线：`remote add|show|remove` 订阅 Git 配置仓库，`sync` 预览并接受固定 commit 的更新。
- `runtime`：连接运行中的 `dsh web`，核对清单插件是否已加载，并说明卡在 pending 的插件。
- `new`：从模板生成 skill / agent / tool / mcp 组件包。
- `--json` 结构化输出，错误同样以 JSON 写入 stderr。
- 示例：GitHub Actions 漂移检查、容器镜像；`make smoke-dsh` 验证新 DSH 版本。
