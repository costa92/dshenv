# {{package}}

DSH MCP server 配置包，由 `dshenv new mcp` 生成。

- `cordis.patch.yml` 插入一行 `dsh-mcp-client`：`serverName` 为 `{{name}}`，默认连接 `http://127.0.0.1:3000/mcp`。改成实际地址，或按注释改用 stdio。

## 开发循环

1. 登记：`dshenv install <本目录> -p <profile>`（`dshenv new -p` 已登记时跳过）。
2. 预览并应用：`dshenv plan`，`dshenv apply --yes`。
3. 修改配置后重启 DSH，然后运行 `dshenv mark-restarted`。
