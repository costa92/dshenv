# {{package}}

DSH skill bundle，由 `dshenv new skill` 生成。

- `skills/{{name}}/SKILL.md`：skill 正文，frontmatter 的 `name` 必须是 kebab-case，`description` 决定 agent 何时使用它。
- `cordis.patch.yml`：挂载一个额外的 `dsh-skill-filesystem` 行，扫描本包的 `skills/` 目录。可在 `skills/` 下继续添加更多 skill。

## 开发循环

1. 登记：`dshenv install <本目录> -p <profile>`（`dshenv new -p` 已登记时跳过）。
2. 预览并应用：`dshenv plan`，`dshenv apply --yes`。
3. 修改 SKILL.md 后 DSH 会监听目录变化；新增 bundle 后需重启 DSH，重启后运行 `dshenv mark-restarted`。
