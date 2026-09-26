# Terminal Workspace MCP

[English](README.md) · [详细操作文档](mcp_server/README.md) · [MIT 许可证](LICENSE)

通过 MCP 操作 Linux 终端。默认只有两个工具：`execute_command` 执行命令，`get_file` 取回原始文件。

- tmux 保持当前目录、环境变量和交互状态，MCP 服务重启后可继续使用。
- 支持回答提示、Ctrl+C 中断、长任务轮询和输出游标续读。
- 原样返回图片和二进制文件，大文件支持分块及 SHA256 校验。
- HTTP 自动协商 gzip；客户端解压后仍得到正常文本和文件。
- IP、端口、工作区、运行目录和限制统一放在配置文件中。

命令使用服务账号权限，可以访问默认工作区之外的文件。请将服务用于可信的客户端和 agent；完整说明见 [SECURITY.md](SECURITY.md)。

## 安装和启动

需要 Linux、Bash、tmux ≥3.2、flock（util-linux）、Node.js ≥22、npm，以及用于服务管理和测试的 Python ≥3.9。当前实现使用 Linux `/proc`，不支持 macOS 和原生 Windows。

```bash
git clone https://github.com/Normalight/terminal-workspace-mcp.git
cd terminal-workspace-mcp
mkdir -p .tmp .cache/npm
npm_config_cache="$PWD/.cache/npm" npm ci --prefix mcp_server

export MCP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export TERMINAL_MCP_TOKEN="$MCP_AUTH_TOKEN"
node mcp_server/src/server.mjs
```

默认 MCP 地址为 `http://127.0.0.1:5679/mcp`，默认工作区为仓库根目录。客户端选择 Streamable HTTP，设置同一地址和 `Authorization: Bearer <同一个 token>`。

远程访问时通过 HTTPS 反向代理或认证隧道连接，将 `client.url` 改为实际入口。兼容的客户端可使用仓库内的[插件连接文件](plugins/terminal-workspace-mcp/README.md)。

## 接入 ChatGPT 与更新

见[完整部署与更新步骤](mcp_server/CHATGPT.zh-CN.md)：包含 Secure MCP Tunnel、本地 Bearer 认证、开发者模式、刷新工具列表和运行版本检查。

ChatGPT 通过隧道或可达的 HTTPS 地址连接正在运行的服务。推送 GitHub 不会部署服务，也不会刷新 ChatGPT 已保存的连接。上面的 Bearer 请求头示例适用于允许自定义请求头的客户端；本项目通过公网 HTTPS 接入 ChatGPT 时还需要兼容的认证网关。

## 配置

统一配置为 `mcp_server/config.json`。本机覆盖放在 Git 已忽略的 `mcp_server/config.local.json`；已有环境变量仍可临时覆盖。持久保存认证值时，可在本地覆盖文件中填写 `{"auth":{"token":"你的token"}}`，并将文件权限设为 0600。

```bash
node mcp_server/scripts/config.mjs show
node mcp_server/scripts/config.mjs sync-plugin
python3 -B mcp_server/scripts/services.py prepare
# 审阅生成的配置，确认系统服务登记符合本机文件路径政策。
python3 -B mcp_server/scripts/services.py install
python3 -B mcp_server/scripts/services.py start --component all
python3 -B mcp_server/scripts/services.py status --component all
```

修改客户端地址后执行 `sync-plugin` 生成两份插件配置，并刷新客户端连接。可选 TCP 转发使用 `--component relay` 管理。MCP、tmux、Relay 和可选 Tunnel 使用独立 systemd 用户服务，不依赖 botmux。配置、凭据、日志和缓存使用工作区路径。登录退出后的运行、开机启动、旧 tmux 无中断迁移及进程归属检查见[独立服务文档](mcp_server/SERVICES.md)。旧 service.py 在安装后转交 systemd 管理。

## 使用

建议每次都使用绝对路径，`get_file` 也一样。新会话明确传入绝对 `cwd`；复用会话时使用绝对路径参数或显式 `cd -- /绝对路径`，不要依赖上次留下的目录状态。

第一次调用 `execute_command` 前先选择稳定的 `terminalKey`（如 `project/agent/task`），再传入 `command`；后续复用返回的 `sessionId`，即可保留 `cd`、环境变量和环境激活状态。

频繁重连的调用方也可从首次命令起指定固定任务键，例如 `{terminalKey:"project/build-42", command:"pwd", cwd:"/绝对项目路径"}`。后续传同一个 `terminalKey` 即可找回原 tmux，跨 MCP 连接和服务重启保留目录、环境及进程；它与 `sessionId` 二选一，不同任务使用不同键。仅查询时不传 `command`，不会新建终端。忙碌终端拒绝第二条命令，可继续读取或发送交互输入。

返回 `terminalReused` 表明是否复用。终端关闭或闲置回收后，读操作仍读取原历史；只有新命令才可创建替代 shell，并返回 `replacedSessionId`，此时应显式初始化工作目录和环境。每条命令仍需保存原始 `sessionId`、`commandId` 和游标，以便任务键指向新终端后读取旧结果。既不传 `sessionId` 也不传 `terminalKey` 的新命令保持新建终端的行为。

- 执行下一条命令：`{sessionId, command}`。
- 续读输出：`{sessionId, commandId, cursor: 上次的nextCursor}`。
- 回答交互提示：`{sessionId, input: "yes\n"}`。
- 中断命令：`{sessionId, key: "C-c"}`。
- 取回文件：`get_file({path:"result.png"})`；大文件使用 `offset` 和 `nextOffset` 分块，后续请求把首个响应的 `version` 传入 `expectedVersion`；文件变化会报 file_changed，需从稳定产物重新读取。

等待时间和输出上限只限制本次返回，不会终止任务。默认返回指定命令的输出范围，省略 cursor 时从该命令开头读取；只有显式 outputScope:"terminal" 才读取共享终端流并默认取尾部。历史读取应固定 commandId。检查 outputGap/outputComplete，区分执行成功与输出完整。PTY 合并 stdout/stderr，可能包含 ANSI 和同时运行的后台进程输出；严格按进程区分的结果应写入独立文件。普通文件编辑、搜索、Git 和进程管理都通过 shell 命令完成。

压缩减少网络字节数；解压后的文字仍占模型上下文。控制上下文大小需要限制返回量、用游标续读，以及将大结果保存为文件。

多个 agent 可同时使用独立 MCP 连接；不同任务使用不同 terminalKey，同终端只允许一条活动命令，多读者各自保存游标。已验证 6 个客户端并发及 MCP 重启后的共同恢复。任务键用于协调，不是权限隔离；所有客户端共享服务账号权限。

## 长任务与会话回收

长任务只启动一次。返回 `status: running` 后，当前 MCP 连接会自动订阅完成通知。调用方保持 GET SSE 或 stdio 监听，服务端通过 `notifications/message` 推送 `logger: terminal-workspace.completion`、`level: notice`、`data.event: command_completed`，包含任务标识、状态、退出码及终端输出结束游标。收到后用保存的 `sessionId`、`commandId` 和 `nextCursor` 续读剩余输出，不再传 `command`。

`notifyOnCompletion:false` 取消该命令的通知；重连新 MCP 会话后传 `{sessionId, commandId, notifyOnCompletion:true, waitMs:0}` 重新订阅，已完成的任务也会补发状态。运行结果持久保存，通知订阅随 MCP 连接管理。短时 GET 断线期间保留待发通知；服务重启后需重新订阅。任务应在前台执行，命令末尾的 `&` 只表示 shell 已完成启动后台进程。

调用方必须处理通知，并允许 `notice` 级日志；服务端无法单方面让客户端或模型自动开始下一轮。不支持事件的客户端继续使用 `sessionId` 和 `nextCursor` 轮询，`waitMs:10000` 至 `30000`。等待到期或连接中断不等于任务失败，不要直接重跑。详见[接入机制与限制](mcp_server/README.md#long-tasks)和[可运行的调用方示例](mcp_server/examples/completion-client.mjs)。

普通工具调用返回有限 JSON 响应；接收事件使用一条持续的 GET SSE。客户端应初始化一次，重复使用 HTTP 请求头 `Mcp-Session-Id`，它与工具参数中的终端 `sessionId` 是两层不同的标识。同一 MCP 会话复用一条 SSE 接收多个任务事件，同一任务的重复订阅会去重。返回的 `completionNotification.listening` 表明当时是否存在监听连接；仅 `subscribed:true` 不代表调用方正在接收事件。

无在途请求、无 SSE 监听的 MCP 会话默认空闲 2 分钟回收，每 10 秒检查；容量满时优先回收已闲置至少 5 秒的最久未使用会话。并发初始化也占用预留名额，防止超配。回收保留 tmux 任务和结果；客户端收到 404 后重新初始化并按保存的任务 ID 续读即可。流程结束主动 DELETE 释放会话。[连接复用与回收细节](mcp_server/README.md#reuse-connections-and-reclaim-short-lived-sessions)。

提供可复用的重连客户端及完成通知示例：只读请求遇到会话失效或临时网络错误时，合并并发重连、退避重试，恢复订阅与游标续读；通知缺失时每 30 秒核对持久状态。示例在提交前保存任务键，之后保存任务 ID 和游标，支持 `completion-client.mjs --resume <状态文件>`。执行请求丢失响应时不自动重发。只有 origin 明确返回 mcp_session_expired、证明尚未派发命令时才可重建连接后重试；普通网关 404 或提交不明仍只读核查。`Unknown tool`、认证或参数错误直接报告。此机制适用于接入该客户端的调用方，托管连接的注册失效仍需在平台刷新连接。

默认每 30 秒检查一次，回收已退出会话及空闲超过 5 分钟的 shell。正在执行命令、有后台子进程、有人连接、手动增加窗口/分屏或标记保留的会话会跳过，日志和文件保留。回收后 shell 的目录和环境变量消失，因此独立操作应明确路径。

新建终端通过 shell 提示符标记确认空闲，保护通过交互输入启动的 `read` 等内建命令；命令结束也会等待日志写入确认。请保留托管 shell 的 `PROMPT_COMMAND`、`DEBUG` trap 和内部状态变量。升级前已存在的终端继续使用原有 shell 和日志协议，缺少新提示符标记的会话会跳过空闲回收；需要新的输出完成保障时请新建会话。

```bash
node mcp_server/scripts/terminals.mjs list
node mcp_server/scripts/terminals.mjs cleanup
node mcp_server/scripts/terminals.mjs cleanup --apply
```

清单包含归属、会话/窗口/面板 ID、状态及是否可回收；`cleanup` 默认只预览。归属通过独立 socket、元数据和标记验证，不只看名字前缀。`terminal.idleTtlMs` 调整空闲时间（`0` 关闭空闲回收），`terminal.gcIntervalMs` 调整检查间隔。需要保留的会话可设置 tmux 会话选项 `@mcp_keep=1`，详见[回收与保留说明](mcp_server/README.md#identify-and-reclaim-managed-tmux-sessions)。

## 测试与贡献

```bash
node --test mcp_server/test/*.test.mjs
node mcp_server/scripts/measure_tools.mjs
```

详细行为和限制见[操作文档](mcp_server/README.md)。欢迎提交可复现问题和 PR，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。代码使用 [MIT 许可证](LICENSE)。
