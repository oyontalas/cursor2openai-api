# CursorIDE2API

> 🔄 将 Cursor IDE 的 Agent API 转换成 OpenAI 兼容接口的轻量中转服务。支持通过 OpenAI SDK / 兼容客户端调用；同时针对 **VSCode Copilot Chat 的 Agent 模式**做了专门的工具调用桥接，让 Copilot 能像连普通模型一样连上 Cursor 的模型。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## ✨ 特性

- 🔌 **OpenAI 兼容** — `/v1/chat/completions` + `/v1/models`，支持文本对话和工具调用桥接
- 🌊 **流式 & 非流式** — 完整支持 SSE 流式响应
- 📦 **无需独立数据库服务** — 运行代理只需 `token.json`；凭据同步脚本读取本机 Cursor 的 SQLite 数据库
- 🔑 **多 Token 轮询** — 支持多账号 round-robin 负载均衡，改 `token.json` 自动热更新
- 🛡️ **可选鉴权** — 环境变量设置 `API_KEY` 即可启用
- 🧩 **VSCode Copilot Agent 桥接** (可选) — 把 Cursor Agent 内部的"写文件"/"跑命令"请求转换成标准 OpenAI `tool_calls`，交还 Copilot 在真实项目目录里执行，详见下文

## 📁 项目结构

```
cursor2openai-api/
├── server.js              # 入口 (路由 + 启动，全合一)
├── src/
│   ├── config.js          # 上游连接与默认配置
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

建议使用 Node.js 24 或更新版本。启动脚本使用 Node 内置的 [`--env-file-if-exists`](https://nodejs.org/api/cli.html#--env-file-if-existsfile)；同步凭据时需先在本机 Cursor 客户端登录。

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
> | `--dry-run` | 预览完整凭据，不写文件；输出含 Token，请勿分享 |
> | `--add` | 强制新增一条记录 (多账号轮询场景)，默认是"更新匹配到的那条/唯一那条" |
> | `--name <label>` | 指定这条记录的 `name` 字段 (默认用账号邮箱) |
> | `--db <path>` | 手动指定 `state.vscdb` 路径 (比如从别的设备拷过来的库文件) |
>
> 通过 npm 传参时加 `--`，例如 `npm run sync-token -- --add --name account-2`。自定义输出路径可使用 `--file <path>`，并让服务端的 `TOKEN_FILE` 指向同一文件。
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

启动后，API 地址为 `http://localhost:3000/v1`。`GET /health` 可检查进程状态，但不会验证上游凭据是否有效。

## 📡 API 使用

当前转换器只处理文本内容，暂不转发图片、音频以及 `temperature`、`max_tokens` 等生成参数。

以下示例假设已启用鉴权。先在调用端终端设置 `API_KEY`，值与服务端 `.env` 一致；Python 示例也读取这一环境变量。

```bash
export API_KEY="你在服务端配置的密钥"
```

### Chat Completions

```bash
# 非流式
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 流式
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 模型列表

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

### Python (OpenAI SDK)

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key=os.environ["API_KEY"]
)

resp = client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True
)

for chunk in resp:
    if chunk.choices and chunk.choices[0].delta.content:
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
| `REQUEST_TIMEOUT` | `120000` | 非流式、未启用桥接时的请求空闲超时 (ms) |
| `CONNECT_RETRY_COUNT` | `2` | 连接 Cursor 后端在拿到任何真实响应前就失败 (纯网络问题), 自动重试的次数 |
| `CONNECT_RETRY_DELAY_MS` | `600` | 上面每次重试之间的等待时间 (ms) |

以下为工具执行、桥接和流式响应配置。`STREAM_*` 同时影响普通流式聊天；服务端工具开关也适用于未声明 `tools` 的请求：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BRIDGE_TOOLS` | _(空=关闭)_ | 设为 `1` 开启 tool_calls 桥接 (推荐, 见下文) |
| `BRIDGE_SHELL` | _(空=关闭)_ | 配合 `BRIDGE_TOOLS=1`, 让客户端弹出确认框后在本地终端真实执行 shell 命令 |
| `WORKSPACE_ROOT` | _(进程 cwd)_ | 服务端直接处理模式下, read/ls/grep/write 的工作目录 |
| `CURSOR_TOOL_MAX_READ_BYTES` | `120000` | 服务端读文件工具返回的最大字节数 |
| `CURSOR_TOOL_MAX_LIST_ENTRIES` | `200` | 服务端目录和搜索工具的条目上限 |
| `ENABLE_WRITE` | _(空=关闭)_ | 设为 `1` 允许 Agent 直接在服务器上写入/删除 `WORKSPACE_ROOT` 内的文件 |
| `ENABLE_SHELL` | _(空=关闭)_ | 设为 `1` 允许 Agent 直接在服务器本机真实执行 shell 命令, 不弹确认框 |
| `SHELL_TIMEOUT_MS` | `120000` | `ENABLE_SHELL=1` 时单条命令的最长执行时间 (ms) |
| `SHELL_MAX_OUTPUT_BYTES` | `200000` | `ENABLE_SHELL=1` 时单条命令输出的最大字节数 |
| `SHELL_FALLBACK_GRACE_MS` | `15000` | 服务端 shell 执行结束后，上游不再推进时的收尾宽限期 (ms) |
| `STREAM_FIRST_CHUNK_TIMEOUT` | `90000` | 等待首个响应字符的基础超时 (ms)，会按 prompt 长度自适应变长 |
| `STREAM_FIRST_CHUNK_TIMEOUT_MAX` | `300000` | 首字超时自适应拉长后的绝对上限 (ms) |
| `STREAM_FIRST_CHUNK_MS_PER_CHAR` | `2` | prompt 每多 1 字符，首字超时增加多少 ms |
| `STREAM_IDLE_TIMEOUT` | `60000` | 流式响应中两帧之间的最长静默时间 (ms) |
| `BRIDGE_SESSION_TIMEOUT` | `1800000` | 等待真人在 IDE 里确认执行 (如 shell 确认框) 的最长时间 (ms)，到点不报错，只回收内存 |

上下文会完整转换为 prompt，不做裁剪或重复调用检测；调用方需管理上下文长度。首字超时随 prompt 长度增长，并受 `STREAM_FIRST_CHUNK_TIMEOUT_MAX` 限制。等待客户端执行工具期间暂停首字和空闲计时，`BRIDGE_SESSION_TIMEOUT` 仅用于回收挂起会话；结果回传时若会话已过期，会带完整历史新建会话。

## 🧰 Agent 工具支持 (VSCode Copilot 专用)

VSCode Copilot Chat 使用标准 OpenAI `tools`/`tool_calls` 协议：请求里会声明它自己支持的工具（`create_file`、`run_in_terminal` 等），并期望模型返回 `tool_calls` 让**它自己**在本地执行，而不是服务器代为执行。桥接需要请求携带 `tools`；未启用桥接时，上游工具请求按服务端工具配置处理。目前桥接针对 `create_file` 和 `run_in_terminal`，不提供任意自定义函数的通用映射。

### 推荐方式：tool_calls 桥接 (`BRIDGE_TOOLS=1`)

开启后，当请求带有 `tools` 字段时，本代理会把 Cursor Agent 内部的"写文件"请求转换成标准的 `create_file` 工具调用交还给 Copilot；Copilot 在**当前打开的项目**里执行完，把结果传回来，代理再喂回 Cursor 的会话继续对话。文件是真的在你本地项目里被创建/修改的，不受服务器 `WORKSPACE_ROOT` 限制。

再加上 `BRIDGE_SHELL=1`，"跑终端命令"也会走同样的桥接：Copilot 会弹出它原生的"允许执行此命令？"确认框，用户确认后命令在**客户端自己的终端**里真实执行。

> **续接方式**：写文件结果优先回传原 Cursor 会话；shell 结果会带完整对话历史新建会话，以避开上游 shell 续接停滞。会话过期或写文件续接失败时，也会尝试新建会话。客户端需在后续请求中保留 `assistant.tool_calls` 和对应的 `role: "tool"` 结果。

### 备用方式：服务端直接处理

不方便走桥接时（比如用 curl/SDK 直接调接口、没有声明 `tools`），也可以让代理自己在**运行本服务的机器**上处理工具请求：

| 工具 | 开关 | 说明 |
|------|------|------|
| 读文件 / 列目录 / grep / glob | 默认开启 | 只读，限定在 `WORKSPACE_ROOT` 内；单文件最多读 `CURSOR_TOOL_MAX_READ_BYTES` 字节 (默认 120000)，列目录/搜索最多返回 `CURSOR_TOOL_MAX_LIST_ENTRIES` 条 (默认 200) |
| 写文件 / 删除文件 | `ENABLE_WRITE=1` | 直接操作服务器磁盘上的 `WORKSPACE_ROOT` |
| Shell 命令 | `ENABLE_SHELL=1` | 用 `child_process.spawn` 在服务器本机真实执行，不弹确认框 |

> ⚠️ `ENABLE_WRITE=1` / `ENABLE_SHELL=1` 会让模型真实改写文件、真实执行命令。如果代理和你的 VSCode/Cursor 在同一台机器上，这等价于让模型拥有你本机的 shell 权限，请只在信任的本地/内网环境开启。同时开启 `BRIDGE_TOOLS`+`BRIDGE_SHELL` 时会优先走桥接（体验更好，有确认框）；只有调用方没声明 `tools` 时才会退回这里。

服务端直接执行 shell 后，若上游在 `SHELL_FALLBACK_GRACE_MS` 内没有继续推进，会以已捕获的命令输出结束响应，此时可能没有模型对结果的进一步总结。`WORKSPACE_ROOT` 是路径范围配置，不是操作系统级沙箱；只应在可信环境中运行。

## 🗺️ 模型选择

请求中的 `model` 原样传给 Cursor，不做别名映射或替换。请通过 `/v1/models` 查询当前账号可用的模型 ID，并填入请求；上面的 `composer-2.5` 仅为示例，以实际返回的列表为准。

未传 `model` 时使用 `DEFAULT_MODEL`（默认 `claude-4.5-sonnet`）。响应中的 `model` 字段与本次传给上游的模型 ID 一致。

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
