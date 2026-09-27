# 通过 Tunnel 在 ChatGPT 创建 Terminal Workspace MCP 应用

[English](CHATGPT.md) · [服务操作文档](README.md)

本教程采用 OpenAI Secure MCP Tunnel 接入已有 HTTP 服务。MCP 进程和隧道客户端运行在你的 Linux 机器上，ChatGPT 选择隧道后远程调用。官方文档及本机隧道客户端参数核对日期：2026-09-27。

```text
ChatGPT 的 MCP 应用（Connection: Tunnel）
    → OpenAI Secure MCP Tunnel
    → Linux 上的 tunnel-client
    → http://127.0.0.1:5679/mcp
    → 持久化 tmux 终端
```

## 0. 创建隧道并准备权限

打开 [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)，选对组织，创建隧道并关联实际使用的 ChatGPT 工作区。保存 `tunnel_id`，按页面指引取得运行密钥。创建需要 Tunnels Read + Manage；运行和在 ChatGPT 选用需要 Read + Use。开发者模式另受账号及工作区权限控制，见[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

| 值 | 配置位置 | 用途 |
| --- | --- | --- |
| `tunnel_id` | 隧道客户端与 ChatGPT 的 Tunnel 表单 | 选择同一条隧道 |
| 隧道运行密钥 | 客户端的 `CONTROL_PLANE_API_KEY` | 隧道客户端连接 OpenAI |
| 本地 MCP token | `config.local.json` 的 `auth.token`，以及隧道的 `MCP_RUNTIME_AUTH` | 隧道访问本机 MCP |

本机地址只供隧道客户端访问。ChatGPT 的 Tunnel 表单选隧道 ID；密钥保存在运行机器。仓库地址不是 MCP 连接地址。

## 1. 启动本地服务

先按仓库 README 安装依赖，以下命令在仓库根目录执行。首次部署用下面的脚本创建本地 token；已有 token 和其他配置会保留。已有部署直接复用当前服务即可。

```bash
mkdir -p .tmp .cache .local/config
export TMPDIR="$PWD/.tmp" TMP="$PWD/.tmp" TEMP="$PWD/.tmp"
export XDG_CACHE_HOME="$PWD/.cache" XDG_CONFIG_HOME="$PWD/.local/config"
export npm_config_cache="$PWD/.cache/npm"
python3 -B - <<'PY'
import json, os, secrets
from pathlib import Path
p = Path('mcp_server/config.local.json')
c = json.loads(p.read_text()) if p.exists() else {}
auth = c.setdefault('auth', {})
if not auth.get('token'):
    auth['token'] = os.environ.get('MCP_AUTH_TOKEN') or secrets.token_hex(32)
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(c, f, indent=2)
p.chmod(0o600)
PY
```

本地联调可使用现有启动入口；需要退出会话后持续运行时，按[独立服务部署](SERVICES.md)安装 systemd 服务。

```bash
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
curl --noproxy '*' -fsS http://127.0.0.1:5679/healthz
```

默认配置应显示 `version: "0.5.8"`、`toolProfile: "minimal"`、`toolCount: 2`。修改过监听地址时相应调整命令。健康检查只能说明服务可用，认证和工具发现还要通过后面的连接验证。

## 2. 使用 Secure MCP Tunnel

从 Platform 隧道页面提供的下载入口获取适配系统架构的客户端，放入工作区的 `.local/bin/` 并赋予执行权限。已有兼容客户端直接复用。客户端需要能访问 OpenAI 的出站 HTTPS 和本地 MCP。

另开终端，在同一仓库根目录执行下面的 HTTP 启动命令。替换可执行文件路径；该示例已与运行版客户端的 `run --help` 核对。新版本的交互式配置/profile 用法可按 `help quickstart` 操作，不要混用不同版本的参数。

```bash
TUNNEL_CLIENT="/absolute/path/to/tunnel-client-runtime"
read -r -p 'Tunnel ID: ' CONTROL_PLANE_TUNNEL_ID
read -r -s -p 'Tunnel runtime key: ' CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY
MCP_AUTH_TOKEN="$(python3 -B -c 'import json; print(json.load(open("mcp_server/config.local.json"))["auth"]["token"])')"
export MCP_RUNTIME_AUTH="Bearer $MCP_AUTH_TOKEN"
mkdir -p .tmp .cache .local/config

TMPDIR="$PWD/.tmp" XDG_CACHE_HOME="$PWD/.cache" \
XDG_CONFIG_HOME="$PWD/.local/config" \
"$TUNNEL_CLIENT" run \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp.server-url http://127.0.0.1:5679/mcp \
  --mcp.extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --mcp.discovery-extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --health.listen-addr 127.0.0.1:8791 \
  --log.file ''
```

保持进程运行，并从另一终端检查下面两个地址。`healthz` 检查进程存活，`readyz` 检查转发就绪；尚未就绪时先查隧道日志。

```bash
curl --noproxy '*' -fsS http://127.0.0.1:8791/healthz
curl --noproxy '*' -fsS http://127.0.0.1:8791/readyz
```

已有部署应复用现有隧道，避免同一隧道 ID 再启动一个轮询进程。需要常驻时，项目的 `services.py prepare --tunnel-spec /绝对路径/private-tunnel.json` 可生成独立 tunnel 单元；具体格式和安装步骤见[服务文档](SERVICES.md)。它不会创建 OpenAI 隧道或代办授权。MCP 更新只重启 server，保留 tunnel 和 terminals。

修改 `client.url` 或执行 `config.mjs sync-plugin` 只更新生成的连接文件，不会配置隧道或在 ChatGPT 中创建应用。

## 3. 在 ChatGPT 创建连接

在 **设置 → 安全与登录（Security and login）** 启用 **开发者模式（Developer mode）**。打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击 **+**，按下表创建应用。入口以 [OpenAI 官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt) 为准。

| 表单项 | 本项目填写内容 |
| --- | --- |
| 名称 | `Terminal Workspace MCP` |
| 描述 | `在个人 Linux 工作区执行命令、恢复长任务并读取文件` |
| Connection | **Tunnel** |
| Tunnel | 第 0 步创建的 `tunnel_id`，从列表选择或粘贴 |

点击创建后等待工具发现。若找不到隧道，先检查工作区关联和使用权限，再检查客户端是否就绪。仓库中的 `.mcp.json` 用于支持该格式的客户端；ChatGPT 此流程直接创建 Tunnel 连接。

默认配置下，应只发现 `execute_command` 和 `get_file`。新开对话，从工具菜单添加该应用，发送：

> 使用 Terminal Workspace MCP 执行 `pwd`，terminalKey 用 `onboarding/check`，taskSummary 为“验证 MCP 连接”，waitMs=1000；返回当前目录和 sessionId。后续查询复用 ID，不重复提交。

成功结果应包含 `sessionId`、`commandId`、`stdout`、`nextCursor`。继续读取同一任务应保持 commandId。长任务返回 `nextAction:defer` 时结束前台轮询；可选 botmux 监听独立发送完成摘要，配置见 [通知说明](README.md#optional-botmux-completion-notifications)。

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

### 工具卡住后显示 `stream recovery polling timed out`

这条网页报错本身不能证明终端命令超时或失败，也不能证明结果已经送到浏览器。需要将卡住那次调用的时间与 MCP 请求审计、隧道响应记录对应起来。OpenAI 的[排查文档](https://developers.openai.com/plugins/deploy/troubleshooting)要求分别检查服务、流式代理和 ChatGPT 客户端；它没有定义这条错误的固定超时阈值。

长任务采用短等待、保存 ID、分次续读。可在对话中使用以下要求：

> 使用稳定 terminalKey，提交命令时 waitMs=1000、maxBytes=16384。保存 sessionId、commandId、nextCursor。未完成则用这些 ID 和游标续读，waitMs=5000；不要再次提交原命令。网页报错后也先查询原任务；若提交回执丢失，先按 terminalKey 查询状态。

这能缩短每次工具请求的等待，并减少返回体大小；不能保证修复 ChatGPT 网页内部的回答流恢复。重开对话后仍可按保存的 ID 读取原任务。若报 `Unknown tool` 且本机没有收到相应请求，应检查所选插件、刷新工具发现并在新对话验证；这与终端任务是否运行是不同问题。

保留发生时间和时区，在仓库根目录收集指定时间窗的诊断（替换示例时间）：

```bash
python3 -B mcp_server/scripts/diagnose_transport.py \
  --since 2026-09-26T23:00:00+08:00 \
  --until 2026-09-26T23:10:00+08:00
```

报告保存到工作区 `outputs/mcp-diagnostics`；自定义部署传 `--config`。HTTP 审计包含保留的轮转片段及跨时间窗的请求，不包含命令正文或认证头。隧道计数仍是进程启动以来的累计值，不能当作该时间窗的错误次数。HTTP 200 也不等于工具业务成功或浏览器已经收到。若没有对应请求，仍需排除审计保留范围之外或日志丢失的情况。


收到 `nextAction:defer` 时，报告任务仍在运行，保存 `monitoring.resume`，结束本轮前台轮询。`checkAfterMs` 只是建议复查间隔，不是完成时间或自动提醒。只有调用方提供了有依据的耗时估计才展示 ETA；无估计或超出估计时应明确未知。
