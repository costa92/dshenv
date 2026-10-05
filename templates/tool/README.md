# {{package}}

DSH tool 插件（纯 JavaScript，免构建），由 `dshenv new tool` 生成。

- `index.js` 导出 Cordis 插件：`inject = ['tools']`，在 `apply` 中用 `defineTool` 注册工具 `{{toolName}}`。
- `@deepseek-ai/dsh-tools` 声明为 peer：以 link 方式安装时解析到当前运行的 DSH，无需 `pnpm install`；需要独立测试时再 `pnpm install`。

## 开发循环

1. 登记：`dshenv install <本目录> -p <profile>`（`dshenv new -p` 已登记时跳过）。
2. 预览并应用：`dshenv plan`，`dshenv apply --yes`。
3. 修改代码后 `dshenv plan` 会显示本地源摘要变化；`dshenv apply --yes` 后重启 DSH，再运行 `dshenv mark-restarted`。
