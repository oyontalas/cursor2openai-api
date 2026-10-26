# CursorIDE2API

> 🔄 将 Cursor IDE 的 Agent API 转换成 OpenAI 兼容接口的轻量中转服务。任何 OpenAI SDK / 客户端都能直接对接；同时针对 **VSCode Copilot Chat 的 Agent 模式**做了专门的工具调用桥接，让 Copilot 能像连普通模型一样连上 Cursor 的模型。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## ✨ 特性

- 🔌 **OpenAI 兼容** — `/v1/chat/completions` + `/v1/models`，可直接对接任何 OpenAI SDK / 兼容客户端
- 🌊 **流式 & 非流式** — 完整支持 SSE 流式响应
- 📦 **零依赖数据库** — 只需一个 `token.json`，无需 SQLite / Redis
- 🔑 **多 Token 轮询** — 支持多账号 round-robin 负载均衡，改 `token.json` 自动热更新
- 🛡️ **可选鉴权** — 环境变量设置 `API_KEY` 即可启用
- 🧩 **VSCode Copilot Agent 桥接** (可选) — 把 Cursor Agent 内部的"写文件"/"跑命令"请求转换成标准 OpenAI `tool_calls`，交还 Copilot 在真实项目目录里执行，详见下文

## 📁 项目结构

```
cursor2openai-api/
├── server.js              # 入口 (路由 + 启动，全合一)
├── src/
│   ├── config.js          # 配置 & 模型映射
│   ├── converter.js       # OpenAI ↔ Cursor 格式转换
│   └── cursor-client.js   # Cursor Agent API 客户端 (H2 + ConnectRPC)
├── scripts/
│   └── sync-token.js      # 从本机 Cursor 客户端提取凭证, 自动写入 token.json
├── token.json.example     # Token 配置模板
├── .env.example           # 环境变量模板
├── package.json
├── LICENSE
└── README.md
```

## 🚀 快速开始

### 1. 克隆 & 安装

```bash
git clone https://github.com/oyontalas/cursor2openai-api.git
cd cursor2openai-api
npm install
```

### 2. 配置 Token

```bash
cp token.json.example token.json
```

编辑 `token.json`，填入你的 Cursor 凭证：

```json
{
  "tokens": [
    {
      "name": "my-account",
      "accessToken": "eyJhbG...",
      "machineId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "macMachineId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ]
}
```

> 💡 换设备 / 换账号时，不用每次都手动翻 SQLite，直接跑：
>
> ```bash
> npm run sync-token
> ```
>
> 会自动从本机 Cursor 客户端的本地数据库里提取当前登录账号的凭证，更新/新增到 `token.json`（旧内容自动备份为 `token.json.bak`）。常用参数：
>
> | 参数 | 作用 |
> |------|------|
> | `--dry-run` | 只打印提取结果，不实际写文件 |
> | `--add` | 强制新增一条记录 (多账号轮询场景)，默认是"更新匹配到的那条/唯一那条" |
> | `--name <label>` | 指定这条记录的 `name` 字段 (默认用账号邮箱) |
> | `--db <path>` | 手动指定 `state.vscdb` 路径 (比如从别的设备拷过来的库文件) |
>
> 服务正在运行时会自动热加载，不需要重启。

<details>
<summary>📖 不想用脚本？也可以手动获取凭证</summary>

Cursor 凭证存储在本地 SQLite 数据库中：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

使用任意 SQLite 工具打开，从 `ItemTable` 表读取：

| Key | 用途 |
|-----|------|
| `cursorAuth/accessToken` | 认证令牌 (**必须**) |
| `telemetry.machineId` | 机器 ID (用于 checksum) |
| `telemetry.macMachineId` | Mac 机器 ID (用于 checksum) |

> ⚠️ 新版 Cursor 客户端 (实测 `3.12.17`) 本地库里已不再单独存 `telemetry.machineId` / `telemetry.macMachineId`，改用 `storage.serviceMachineId` 作为 `machineId` 即可，`macMachineId` 留空不影响使用。

</details>

### 3. 配置环境变量

```bash
cp .env.example .env
```

至少设置一个你自己的 `API_KEY`（留空则不校验，任何人都能直接调用，不推荐）：

```bash
API_KEY=你自己的密钥
```

`npm start` 会自动读取 `.env`（基于 Node 内置的 `--env-file-if-exists`，无需额外依赖）。

如果你只需要普通的 OpenAI 兼容聊天接口，到这一步就配置完了，可以直接跳到「启动」。如果你想接入 **VSCode Copilot Chat 的 Agent 模式**（让它能创建文件、跑终端命令），再看一眼下面的「Agent 工具支持」章节，按需开启 `BRIDGE_TOOLS` / `BRIDGE_SHELL`。

### 4. 启动

```bash
npm start
```

```
  ╔═══════════════════════════════════════════╗
  ║       CursorIDE2API v2.0 (Lite)           ║
  ╠═══════════════════════════════════════════╣
  ║  🌐 http://0.0.0.0:3000                   ║
  ║  🔌 /v1/chat/completions                  ║
  ║  📋 /v1/models                            ║
  ╠═══════════════════════════════════════════╣
  ║  🔑 Tokens: 1                              ║
  ║  🤖 Default: claude-4.5-sonnet             ║
  ║  🔐 API Key: OPEN (no key)                 ║
  ╚═══════════════════════════════════════════╝
```

## 📡 API 使用

### Chat Completions

```bash
# 非流式
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 流式
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 模型列表

```bash
curl http://localhost:3000/v1/models
```

### 带 API Key

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hi"}]}'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="any-string"  # 未设置 API_KEY 时填任意值
)

resp = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True
)

for chunk in resp:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### VSCode Copilot Chat

在 VSCode 里把 Copilot Chat 的模型指向本服务的 `/v1` 地址（比如通过支持自定义 OpenAI 端点的模型提供方设置），`API_KEY` 填你在 `.env` 里设置的那个。普通对话开箱即用；要让 Copilot 的 Agent 模式（创建文件、跑终端命令）也能工作，见下一节。

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `API_KEY` | _(空=不校验)_ | API 鉴权密钥 |
| `TOKEN_FILE` | `./token.json` | Token 文件路径 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet` | 默认 Cursor 模型 |
| `CURSOR_CLIENT_VERSION` | `3.12.17` | Cursor 客户端版本号 (需跟上游保持较新, 太旧会被拒 "Update Required") |
| `REQUEST_TIMEOUT` | `120000` | 请求超时 (ms) |
| `CONNECT_RETRY_COUNT` | `2` | 连接 Cursor 后端在拿到任何真实响应前就失败 (纯网络问题), 自动重试的次数 |
| `CONNECT_RETRY_DELAY_MS` | `600` | 上面每次重试之间的等待时间 (ms) |

以下变量只影响 **Agent 工具调用**（Copilot 这类会声明 `tools` 的客户端），普通聊天完全不受影响：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BRIDGE_TOOLS` | _(空=关闭)_ | 设为 `1` 开启 tool_calls 桥接 (推荐, 见下文) |
| `BRIDGE_SHELL` | _(空=关闭)_ | 配合 `BRIDGE_TOOLS=1`, 让客户端弹出确认框后在本地终端真实执行 shell 命令 |
| `WORKSPACE_ROOT` | _(进程 cwd)_ | 服务端直接处理模式下, read/ls/grep/write 的工作目录 |
| `ENABLE_WRITE` | _(空=关闭)_ | 设为 `1` 允许 Agent 直接在服务器上写入/删除 `WORKSPACE_ROOT` 内的文件 |
| `ENABLE_SHELL` | _(空=关闭)_ | 设为 `1` 允许 Agent 直接在服务器本机真实执行 shell 命令, 不弹确认框 |
| `SHELL_TIMEOUT_MS` | `120000` | `ENABLE_SHELL=1` 时单条命令的最长执行时间 (ms) |
| `SHELL_MAX_OUTPUT_BYTES` | `200000` | `ENABLE_SHELL=1` 时单条命令输出的最大字节数 |
| `SHELL_FALLBACK_GRACE_MS` | `15000` | shell 命令真实执行完毕后的收尾宽限期，见下文说明 |
| `STREAM_FIRST_CHUNK_TIMEOUT` | `90000` | 等待首个响应字符的基础超时 (ms)，会按 prompt 长度自适应变长 |
| `STREAM_FIRST_CHUNK_TIMEOUT_MAX` | `300000` | 首字超时自适应拉长后的绝对上限 (ms) |
| `STREAM_FIRST_CHUNK_MS_PER_CHAR` | `2` | prompt 每多 1 字符，首字超时增加多少 ms |
| `STREAM_IDLE_TIMEOUT` | `60000` | 流式响应中两帧之间的最长静默时间 (ms) |
| `BRIDGE_SESSION_TIMEOUT` | `1800000` | 等待真人在 IDE 里确认执行 (如 shell 确认框) 的最长时间 (ms)，到点不报错，只回收内存 |

> **关于上下文长度/死循环**：本服务定位是纯中转/桥接，重建历史 prompt 时不做长度裁剪、也不做重复调用检测——上下文窗口大小、任务是否陷入死循环等应由调用方 (agent/客户端) 自行控制和判断；如果重建出来的 prompt 确实超出了模型的上下文上限，会由 Cursor 后端自然报错，本服务只是原样把这个错误透传给调用方，不会尝试静默截断或注入额外的提示文字去"纠正"模型的行为。

> **超时设计原则**：只有真正判断"模型/网络卡住没反应"时才应该超时；等真人确认 (比如 shell 的允许执行确认框) 属于合理的、可能很长的等待，不该被当成超时处理掉。因此 `pauseSession` 交还 `tool_calls` 给客户端后，会显式清掉 `STREAM_FIRST_CHUNK_TIMEOUT`/`STREAM_IDLE_TIMEOUT` 这两个计时器；等待期间唯一还在跑的 `BRIDGE_SESSION_TIMEOUT` 到点了也只是清内存，不会让任务报错——真人晚一点确认，服务端会自动改用"开新会话续接完整历史"接着处理，不会中断。真正的网络层失败（比如 TLS 握手中途被打断）会走 `CONNECT_RETRY_COUNT` 自动重试。
>
> **为什么首字超时会随 prompt 长度自适应拉长**：shell/shellStream 续接不上原会话时，会带着完整对话历史开新会话重试；任务步骤越多，这段历史就越长，Cursor 后端处理耗时也越长。曾在一次长任务里观察到 prompt 从 28K 字符涨到 46K 字符、最终触发固定 60 秒的首字超时把整段对话中断，因此改成随 prompt 长度自适应拉长超时上限（见 `STREAM_FIRST_CHUNK_MS_PER_CHAR`），而不是去限制 prompt 本身的长度。

## 🧰 Agent 工具支持 (VSCode Copilot 专用)

VSCode Copilot Chat 使用标准 OpenAI `tools`/`tool_calls` 协议：请求里会声明它自己支持的工具（`create_file`、`run_in_terminal` 等），并期望模型返回 `tool_calls` 让**它自己**在本地执行，而不是服务器代为执行。不带 `tools` 字段的普通请求完全不受这套逻辑影响。

### 推荐方式：tool_calls 桥接 (`BRIDGE_TOOLS=1`)

开启后，当请求带有 `tools` 字段时，本代理会把 Cursor Agent 内部的"写文件"请求转换成标准的 `create_file` 工具调用交还给 Copilot；Copilot 在**当前打开的项目**里执行完，把结果传回来，代理再喂回 Cursor 的会话继续对话。文件是真的在你本地项目里被创建/修改的，不受服务器 `WORKSPACE_ROOT` 限制。

再加上 `BRIDGE_SHELL=1`，"跑终端命令"也会走同样的桥接：Copilot 会弹出它原生的"允许执行此命令？"确认框，用户确认后命令在**客户端自己的终端**里真实执行。

> **已知限制**：Cursor 后端在收到桥接结果（无论是写文件还是 shell 结果）后，通常不会像处理原生工具那样干净地结束这次工具调用（只会发心跳，不推进对话）。因为客户端那边其实已经真实完成了操作并拿到了正确结果，代理会在收到结果后等待 `SHELL_FALLBACK_GRACE_MS`（默认 15 秒，写文件桥接则更快）——如果这段时间内会话仍未推进，就直接用已经拿到的真实结果收尾返回。代价是可能拿不到模型对结果的二次总结（返回的是原始执行结果），但功能上可用，读写和 shell 都已端到端验证。

### 备用方式：服务端直接处理

不方便走桥接时（比如用 curl/SDK 直接调接口、没有声明 `tools`），也可以让代理自己在**运行本服务的机器**上处理工具请求：

| 工具 | 开关 | 说明 |
|------|------|------|
| 读文件 / 列目录 / grep / glob | 默认开启 | 只读，限定在 `WORKSPACE_ROOT` 内；单文件最多读 `CURSOR_TOOL_MAX_READ_BYTES` 字节 (默认 120000)，列目录/搜索最多返回 `CURSOR_TOOL_MAX_LIST_ENTRIES` 条 (默认 200) |
| 写文件 / 删除文件 | `ENABLE_WRITE=1` | 直接操作服务器磁盘上的 `WORKSPACE_ROOT` |
| Shell 命令 | `ENABLE_SHELL=1` | 用 `child_process.spawn` 在服务器本机真实执行，不弹确认框 |

> ⚠️ `ENABLE_WRITE=1` / `ENABLE_SHELL=1` 会让模型真实改写文件、真实执行命令。如果代理和你的 VSCode/Cursor 在同一台机器上，这等价于让模型拥有你本机的 shell 权限，请只在信任的本地/内网环境开启。同时开启 `BRIDGE_TOOLS`+`BRIDGE_SHELL` 时会优先走桥接（体验更好，有确认框）；只有调用方没声明 `tools` 时才会退回这里。

原理：OpenAI 的 `/v1/chat/completions` 本身无状态，每次都要带上完整 `messages`。代理暂停等待客户端执行工具时，底层与 Cursor 的连接不会关闭，会保持在内存中等待客户端把 `role: "tool"` 结果通过下一次请求传回来，再恢复连接继续对话。超过 `BRIDGE_SESSION_TIMEOUT`（默认 30 分钟）没有回传则自动回收内存（不影响任务，回传时会自动改用开新会话续接）。

## 🗺️ 模型映射

传入 OpenAI 风格模型名会自动映射到 Cursor 原生模型：

| 传入 | 映射到 |
|------|--------|
| `gpt-4` / `gpt-4o` / `gpt-4-turbo` | `composer-2.5` |
| `gpt-4o-mini` / `gpt-3.5-turbo` | `composer-2.5-fast` |
| `claude-3-opus` | `claude-4.6-opus-high` |
| `claude-3-sonnet` | `claude-4.6-sonnet-medium` |
| `claude-3.5-sonnet` | `claude-4.5-sonnet` |
| `gemini-pro` | `gemini-3.1-pro` |

> 💡 也可直接传 Cursor 原生模型名 (如 `composer-2.5`、`claude-4.5-sonnet-thinking`)，会直接透传。
>
> 📌 响应里的 `model` 字段返回的是**实际回答的 Cursor 模型**（映射后的目标，如 `composer-2.5`），而不是原样回显你传入的别名（如 `gpt-4`），避免造成"以为是某个模型在回答，实际是另一个"的误导。想知道某个别名具体会打到哪个模型，可查上表，或直接看服务端终端日志（会打印 `别名 → 实际模型`）。

## 🏗️ 技术原理

本项目基于对 Cursor IDE `workbench.desktop.main.js` 的逆向分析：

1. 使用 **ConnectRPC over HTTP/2** 协议连接 `api2.cursor.sh`
2. 调用 `agent.v1.AgentService/Run` 双向流接口
3. 处理 Envelope 帧编码 (5 字节头 + JSON payload)
4. 实时解析 `interactionUpdate` 流并转为 OpenAI SSE 格式
5. 自动回复/桥接 `execServerMessage`（read/ls/grep/write/shell）

## 📄 License

[MIT](LICENSE)

## ⚠️ 免责声明

本项目仅供学习研究使用。使用本项目须遵守 Cursor IDE 的服务条款，开发者不对任何滥用行为负责。

---

<sub>本仓库修改自 [sdsdsdsdsdsihdkjsdjl/cursoride2api](https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api)。</sub>
