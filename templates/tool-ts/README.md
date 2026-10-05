# {{package}}

DSH tool 插件（TypeScript），由 `dshenv new tool --typescript` 生成。

- 源码在 `src/index.ts`，`pnpm build` 编译到 `lib/`；`package.json` 的 `exports` 指向 `lib/index.js`。
- **首次使用前必须构建**：`pnpm install && pnpm build`，否则 DSH 找不到 `lib/index.js`。

## 开发循环

1. 构建：`pnpm install && pnpm build`。
2. 登记：`dshenv install <本目录> -p <profile>`（`dshenv new -p` 已登记时跳过）。
3. 预览并应用：`dshenv plan`，`dshenv apply --yes`。
4. 修改后重新 `pnpm build`，`dshenv plan` 会显示本地源摘要变化；`dshenv apply --yes` 后重启 DSH，再运行 `dshenv mark-restarted`。
