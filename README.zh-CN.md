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
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
python3 -B mcp_server/scripts/service.py restart
python3 -B mcp_server/scripts/service.py stop
```

修改客户端地址后执行 `sync-plugin` 生成两份插件配置，并刷新客户端连接。可选 TCP 转发使用 `--component relay` 管理。该脚本管理后台进程；开机启动和故障自动拉起可由系统服务管理器负责。

## 使用

建议每次都使用绝对路径，`get_file` 也一样。新会话明确传入绝对 `cwd`；复用会话时使用绝对路径参数或显式 `cd -- /绝对路径`，不要依赖上次留下的目录状态。

第一次调用 `execute_command` 传入 `command`；后续复用返回的 `sessionId`，即可保留 `cd`、环境变量和环境激活状态。

- 执行下一条命令：`{sessionId, command}`。
- 续读输出：`{sessionId, cursor: 上次的nextCursor}`。
- 回答交互提示：`{sessionId, input: "yes\n"}`。
- 中断命令：`{sessionId, key: "C-c"}`。
- 取回文件：`get_file({path:"result.png"})`；大文件使用 `offset` 和 `nextOffset` 分块。

等待时间和输出上限只限制本次返回，不会终止任务。终端输出会合并 stdout/stderr，可能包含 ANSI 控制符。普通文件编辑、搜索、Git 和进程管理都通过 shell 命令完成。

压缩减少网络字节数；解压后的文字仍占模型上下文。控制上下文大小需要限制返回量、用游标续读，以及将大结果保存为文件。

## 长任务与会话回收

长任务只启动一次。返回 `status: running` 后，用 `sessionId` 和上次的 `nextCursor` 继续轮询，不再传 `command`；输出稀疏时设置 `waitMs:10000` 至 `30000`。等待到期或连接中断不等于任务失败，不要直接重跑。完成前检查最终 `status`、`exitCode` 并读完剩余输出；交接时保存会话 ID、游标和绝对日志/产物路径。会话结束后继续监控需要客户端或另行配置的调度器。

默认每 30 秒检查一次，回收已退出会话及空闲超过 5 分钟的 shell。正在执行命令、有后台子进程、有人连接、手动增加窗口/分屏或标记保留的会话会跳过，日志和文件保留。回收后 shell 的目录和环境变量消失，因此独立操作应明确路径。

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
