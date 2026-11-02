# CursorIDE2API

> 将 Cursor 的文本聊天接口转换为 OpenAI 兼容的 `/v1/chat/completions` 和 `/v1/models`，支持流式与非流式响应。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## ✨ 特性

- 🔌 **OpenAI 兼容** — `/v1/chat/completions` + `/v1/models`，支持文本对话
- 🌊 **流式 & 非流式** — 完整支持 SSE 流式响应
- 📦 **无需独立数据库服务** — 运行代理只需 `token.json`；凭据同步脚本读取本机 Cursor 的 SQLite 数据库
- 🔑 **多 Token 轮询** — 支持多账号 round-robin 负载均衡，改 `token.json` 自动热更新
- 🛡️ **可选鉴权** — 环境变量设置 `API_KEY` 即可启用

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
├── test/
│   └── chat.test.js       # 文本聊天、协议处理和工具拒绝的回归测试
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

### 4. 启动

```bash
npm start
```

启动后，API 地址为 `http://localhost:3000/v1`。`GET /health` 可检查进程状态，但不会验证上游凭据是否有效。

## 📡 API 使用

当前支持文本消息（`system`、`developer`、`user`、`assistant`）。工具调用及工具结果消息返回 HTTP 400；代理不会读写工作区文件或执行命令。图片、音频以及 `temperature`、`max_tokens` 等生成参数暂不支持。

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

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `API_KEY` | _(空=不校验)_ | API 鉴权密钥 |
| `TOKEN_FILE` | `./token.json` | Token 文件路径 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet` | 默认 Cursor 模型 |
| `CURSOR_CLIENT_VERSION` | `3.12.17` | Cursor 客户端版本号 (需跟上游保持较新, 太旧会被拒 "Update Required") |
| `REQUEST_TIMEOUT` | `120000` | 非流式请求空闲超时 (ms) |
| `CONNECT_RETRY_COUNT` | `2` | 连接 Cursor 后端在拿到任何真实响应前就失败 (纯网络问题), 自动重试的次数 |
| `CONNECT_RETRY_DELAY_MS` | `600` | 上面每次重试之间的等待时间 (ms) |

流式响应使用以下超时配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `STREAM_FIRST_CHUNK_TIMEOUT` | `90000` | 等待首个响应字符的基础超时 (ms) |
| `STREAM_FIRST_CHUNK_TIMEOUT_MAX` | `300000` | 首字超时的上限 (ms) |
| `STREAM_FIRST_CHUNK_MS_PER_CHAR` | `2` | prompt 每个字符增加的等待时间 (ms) |
| `STREAM_IDLE_TIMEOUT` | `60000` | 流式响应中业务数据的空闲超时 (ms) |

每次请求都将完整文本历史转换为 prompt，不做上下文裁剪。首字超时随 prompt 长度增长，并受上述上限约束。

## 🗺️ 模型选择

请求中的 `model` 原样传给 Cursor，不做别名映射或替换。请通过 `/v1/models` 查询当前账号可用的模型 ID，并填入请求；上面的 `composer-2.5` 仅为示例，以实际返回的列表为准。

未传 `model` 时使用 `DEFAULT_MODEL`（默认 `claude-4.5-sonnet`）。响应中的 `model` 字段与本次传给上游的模型 ID 一致。

## 🏗️ 技术原理

本项目基于对 Cursor IDE `workbench.desktop.main.js` 的逆向分析：

1. 使用 **ConnectRPC over HTTP/2** 协议连接 `api2.cursor.sh`
2. 调用 `agent.v1.AgentService/Run` 双向流接口
3. 处理 Envelope 帧编码 (5 字节头 + JSON payload)
4. 实时解析 `interactionUpdate` 流并转为 OpenAI SSE 格式
5. 仅回复上游协议所需的环境信息；收到工具执行请求时结束请求并返回错误

## 测试

运行 `npm test`。测试使用模拟凭据和上游响应，覆盖文本聊天、流式输出、模型名透传、鉴权，以及客户端和上游工具请求的拒绝，不会连接真实账号。

## 📄 License

[MIT](LICENSE)

## ⚠️ 免责声明

本项目仅供学习研究使用。使用本项目须遵守 Cursor IDE 的服务条款，开发者不对任何滥用行为负责。

---

<sub>本仓库修改自 [sdsdsdsdsdsihdkjsdjl/cursoride2api](https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api)。</sub>
