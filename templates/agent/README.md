# {{package}}

DSH agent 预设，由 `dshenv new agent` 生成。

- `cordis.patch.yml` 插入一个 `dsh-agent-preset` 行，`config.id` 为 `{{name}}`，是会话保存的预设标识。
- `plugins` 就是该 agent 的全部能力：默认只有 `dsh-persona`。需要工具时，从 DSH 的 `dsh-web-app` 包 `presets/minimal.patch.yml` 拷贝对应行；需要委派子 agent 时，取消 `dsh-tool-subagent` 的注释。
- agent 预设由 web 界面（`dsh web`，`dsh-web-app` 提供预设注册表）使用。

## 开发循环

1. 登记：`dshenv install <本目录> -p <profile>`（`dshenv new -p` 已登记时跳过）。
2. 预览并应用：`dshenv plan`，`dshenv apply --yes`。
3. 修改 `cordis.patch.yml` 后重启 DSH，然后运行 `dshenv mark-restarted`。
