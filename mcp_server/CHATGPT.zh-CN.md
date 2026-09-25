# 将 Terminal Workspace MCP 接入 ChatGPT

[English](CHATGPT.md) · [服务操作文档](README.md)

MCP 进程运行在你的 Linux 机器上，ChatGPT 远程调用，GitHub 保存源码。这里说明个人开发者模式的连接方式，官方文档核对日期为 2026-09-25。

## 1. 启动本地服务

先按仓库 README 安装依赖，以下命令在仓库根目录执行。在已忽略的 `mcp_server/config.local.json` 中持久保存 `auth.token`，权限设为 0600；也可以在启动前导出 `MCP_AUTH_TOKEN`。隧道需要使用同一个 token。

```bash
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
curl --noproxy '*' -fsS http://127.0.0.1:5679/healthz
```

默认配置应显示 `version: "0.4.0"`、`toolProfile: "minimal"`、`toolCount: 2`。修改过监听地址时相应调整命令。健康检查只能说明服务可用，认证和工具发现还要通过后面的连接验证。

## 2. 使用 Secure MCP Tunnel

个人使用可保持 MCP 只监听本机回环地址。按 [OpenAI 官方隧道指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 获取客户端并创建隧道，将隧道关联到实际使用的 ChatGPT 工作区；创建连接的人需要 Tunnels Read + Use 权限。隧道客户端需要访问 OpenAI 的出站 HTTPS 和本地 MCP。

下面是运行版客户端支持的 HTTP 启动参数。替换可执行文件路径，并用该版本的 `run --help` 核对参数。依次输入隧道 ID、隧道运行密钥和第 1 步的**现有 MCP token**：

```bash
TUNNEL_CLIENT="/absolute/path/to/tunnel-client-runtime"
read -r -p 'Tunnel ID: ' CONTROL_PLANE_TUNNEL_ID
read -r -s -p 'Tunnel runtime key: ' CONTROL_PLANE_API_KEY
printf '\n'
read -r -s -p 'Existing MCP token: ' MCP_AUTH_TOKEN
printf '\n'
export CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY
export MCP_RUNTIME_AUTH="Bearer $MCP_AUTH_TOKEN"
mkdir -p .tmp .cache .local/config

TMPDIR="$PWD/.tmp" XDG_CACHE_HOME="$PWD/.cache" \
XDG_CONFIG_HOME="$PWD/.local/config" \
"$TUNNEL_CLIENT" run \
  --mcp.server-url http://127.0.0.1:5679/mcp \
  --mcp.extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --mcp.discovery-extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --health.listen-addr 127.0.0.1:8791
```

保持进程运行。已有部署应复用现有隧道，避免同一隧道 ID 再启动一个轮询进程。隧道运行密钥用于连接 OpenAI，本地 MCP token 用于隧道到服务这一段认证，两者用途不同。项目的 `service.py` 管理 MCP 服务和可选 TCP 转发，不管理隧道客户端；持久运行隧道应交给你的进程管理器。

修改 `client.url` 或执行 `config.mjs sync-plugin` 只更新生成的连接文件，不会配置隧道或在 ChatGPT 中创建应用。

## 3. 在 ChatGPT 创建连接

在 **设置 → 安全与登录（Security and login）** 启用 **开发者模式（Developer mode）**。打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击 **+**，命名为 **Terminal Workspace MCP**，连接方式选择 **Tunnel**，选择或填入隧道 ID 后创建。功能可用性受账号和工作区策略影响。入口以 [OpenAI 官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt) 为准。

默认配置下，应只发现 `execute_command` 和 `get_file`。新开对话并启用该连接，让它执行 `pwd`；成功结果应包含 `sessionId`、`stdout`、`nextCursor`。

### 公网 HTTPS 方式

ChatGPT 也能连接 HTTPS `/mcp` 地址。本项目目前验证固定 Bearer token，没有实现 OAuth 发现和登录；ChatGPT 直连不能填写自定义 API key。需要用兼容 OAuth 的网关完成用户认证，再由网关向本地 MCP 注入 token，普通 HTTPS 反向代理本身不能完成这一步。参见 [OpenAI 认证规范](https://developers.openai.com/plugins/build/auth)。不要将账号级终端以匿名方式开放到公网。

## 4. 更新服务和 ChatGPT 工具列表

如果部署直接运行公开仓库的干净克隆，在该仓库根目录执行：

```bash
git pull --ff-only
mkdir -p .tmp .cache/npm
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" \
  npm ci --prefix mcp_server
python3 -B mcp_server/scripts/service.py restart
python3 -B mcp_server/scripts/service.py status
curl --noproxy '*' -fsS http://127.0.0.1:5679/healthz
```

如果实际部署源码在其他目录，沿用该部署的更新流程。保留本地配置和 token。若使用 stdio，由隧道管理 MCP 子进程，应重启对应子进程；上述命令管理的是 HTTP 服务。

随后到 ChatGPT Plugins 打开已保存的连接，点击 **Refresh（刷新）**，确认工具名称与参数，再**新开对话**。这是官方的[开发者模式刷新流程](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)。服务实现更新在部署后生效；工具名称、参数或说明改变时，还需要更新 ChatGPT 保存的元数据。推送 GitHub、修改本地插件清单或重启服务都不会代替这次刷新。

若仍显示旧工具，检查连接指向的隧道和服务，以及 `tools.profile="minimal"`。新版 `execute_command` 应接受 `sessionId`、`input`、`key`、`cursor`，`get_file` 应接受 `offset`。看不到 Refresh 时先检查开发者模式权限，也可为同一个可用隧道新建连接；新连接通过工具发现前保留旧连接。

### 界面版本一直显示 1.0.0

先区分字段：正在运行的服务版本由 `/healthz` 和 MCP `initialize.result.serverInfo.version` 返回。本地插件包版本、ChatGPT 已保存的连接元数据是不同的记录；修改本地清单不会直接修改那个连接。清单里 `schemas/1.0.0/` 地址指的是文件格式规范版本，不是服务版本。

如果运行检查已经返回预期版本，但 ChatGPT 仍展示旧工具名称或参数，就刷新连接并新开对话。仅凭界面上的数字无法判定实际运行版本，需要同时核对所连接的服务和发现的工具参数。

## 排查

| 现象 | 检查内容 |
| --- | --- |
| 本地健康检查失败 | 服务状态、监听地址和运行目录日志。 |
| ChatGPT 找不到隧道 | 工作区关联及 Tunnels Read + Use 权限。 |
| 工具发现返回 401 | 转发与发现请求是否都携带现有 MCP token。 |
| 隧道断线 | 客户端进程、出站网络及运行密钥。 |
| 服务已更新但工具仍旧 | 刷新已保存的连接，并新开对话。 |
| 公网 HTTPS 认证失败 | 配置 OAuth 网关；本地 token 环境变量不是 ChatGPT 的凭据设置。 |
