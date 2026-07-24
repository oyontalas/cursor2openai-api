// ═══════════════════════════════════════════════════
//  CursorIDE2API v2 - 极简版
//  token.json → 反代 Cursor API → OpenAI 兼容接口
// ═══════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cursorClient = require('./src/cursor-client');
const converter = require('./src/converter');

// stdout/stderr 没有连接真正的 TTY 时 (比如被重定向到文件, 或跑在 nohup/后台管理工具里),
// Node 默认会做全缓冲, 导致 console.log 攒很久才真正落地 (甚至要等进程退出才 flush)。
// 强制切成同步阻塞写入, 保证每次请求的日志能立刻打印出来。
for (const stream of [process.stdout, process.stderr]) {
  if (stream._handle && typeof stream._handle.setBlocking === 'function') {
    stream._handle.setBlocking(true);
  }
}

// ── 配置 ──
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';  // 留空 = 不校验
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, 'token.json');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-4.5-sonnet';
const CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION || '3.12.17';

// tool_calls 桥接: 客户端 (如 VSCode Copilot) 声明了 tools 时,
// 把 Cursor 内部的 write/shell 请求转换成 OpenAI tool_calls 交还客户端本地执行。
const BRIDGE_TOOLS = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_TOOLS || '');

// ── 加载 Tokens ──
let tokens = [];
let roundRobinIndex = 0;

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      console.error(`  ❌ token.json not found: ${TOKEN_FILE}`);
      console.error('  📝 Create token.json with your Cursor credentials');
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    tokens = (data.tokens || []).filter(t => t.accessToken && t.accessToken !== 'your-cursor-access-token-here');
    if (tokens.length === 0) {
      console.error('  ❌ No valid tokens in token.json');
      console.error('  📝 Add at least one token with a valid accessToken');
      process.exit(1);
    }
    return tokens.length;
  } catch (e) {
    console.error(`  ❌ Failed to load token.json: ${e.message}`);
    process.exit(1);
  }
}

// 监听 token.json 变化, 自动热更新
function watchTokenFile() {
  try {
    fs.watchFile(TOKEN_FILE, { interval: 5000 }, () => {
      try {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        const newTokens = (data.tokens || []).filter(t => t.accessToken && t.accessToken !== 'your-cursor-access-token-here');
        if (newTokens.length > 0) {
          tokens = newTokens;
          roundRobinIndex = 0;
          console.log(`  🔄 token.json reloaded: ${tokens.length} token(s)`);
        }
      } catch {}
    });
  } catch {}
}

// 轮询选 token
function pickToken() {
  if (tokens.length === 0) return null;
  roundRobinIndex = roundRobinIndex % tokens.length;
  const token = tokens[roundRobinIndex];
  roundRobinIndex++;
  return {
    accessToken: token.accessToken,
    machineId: token.machineId || '',
    macMachineId: token.macMachineId || '',
  };
}

// ── Express 应用 ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── API Key 简单校验 ──
function checkApiKey(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
  const key = auth.replace(/^Bearer\s+/i, '');
  if (key !== API_KEY) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  next();
}

// ── GET /v1/models ──
app.get('/v1/models', checkApiKey, async (req, res) => {
  try {
    const token = pickToken();
    if (!token) return res.json({ object: 'list', data: [] });
    const result = await cursorClient.getModels(token);
    res.json(converter.buildModelsResponse(result.models || []));
  } catch {
    res.json({ object: 'list', data: [] });
  }
});

// 取出消息数组末尾连续的 role=tool 消息 (代表客户端刚执行完某次 tool_calls 并把结果传回来)
function extractTrailingToolMessages(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'tool' && m.tool_call_id) out.unshift(m);
    else break;
  }
  return out;
}

function toolMessageContentText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  if (m.content == null) return '';
  try { return JSON.stringify(m.content); } catch { return String(m.content); }
}

// ── POST /v1/chat/completions ──
app.post('/v1/chat/completions', checkApiKey, async (req, res) => {
  const { messages, model, stream, tools } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json(converter.buildErrorResponse('messages is required', 'invalid_request_error', 400));
  }

  const token = pickToken();
  if (!token) {
    return res.status(503).json(converter.buildErrorResponse('No available tokens', 'server_error', 503));
  }

  const requestedModel = model || 'gpt-4';
  const cursorModel = converter.mapModel(requestedModel);
  const isStream = stream === true;

  // 是否是"工具调用结果回传"请求: 消息末尾是连续的 role=tool
  const trailingToolMsgs = extractTrailingToolMessages(messages);
  const isToolContinuation = BRIDGE_TOOLS && trailingToolMsgs.length > 0;
  const toolMsg = isToolContinuation ? trailingToolMsgs[0] : null;
  const bridgeTools = BRIDGE_TOOLS && Array.isArray(tools) && tools.length > 0;

  const prompt = isToolContinuation ? '' : converter.messagesToPrompt(messages);

  if (isToolContinuation) {
    console.log(`  🔧 [${new Date().toLocaleTimeString()}] tool result ← ${toolMsg.tool_call_id}`);
  } else {
    console.log(`  📨 [${new Date().toLocaleTimeString()}] ${requestedModel} → ${cursorModel} | stream=${isStream}${bridgeTools ? ' | bridgeTools=on' : ''} | prompt=${prompt.length}字符`);
  }

  // 统一发起/恢复调用, 返回 { type: 'final', ... } 或 { type: 'tool_calls', toolCalls, sessionId }
  function runTurn(runtimeOptions) {
    if (isToolContinuation) {
      return cursorClient.resumeToolCall(toolMsg.tool_call_id, toolMessageContentText(toolMsg), runtimeOptions);
    }
    return cursorClient.chat(token, prompt, cursorModel, { ...runtimeOptions, bridgeTools });
  }

  if (isStream) {
    // ── 流式响应 ──
    const controller = new AbortController();
    let responseDone = false;
    let keepAlive = null;

    const finishStream = () => {
      if (responseDone || res.writableEnded) return;
      responseDone = true;
      if (keepAlive) clearInterval(keepAlive);
      res.write(converter.buildStreamChunk(null, cursorModel, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const finishToolCalls = (toolCalls) => {
      if (responseDone || res.writableEnded) return;
      responseDone = true;
      if (keepAlive) clearInterval(keepAlive);
      res.write(converter.buildToolCallStreamChunk(toolCalls, cursorModel));
      res.write(converter.buildToolCallFinishChunk(cursorModel));
      res.write('data: [DONE]\n\n');
      res.end();
    };

    // 客户端断开时取消上游请求
    res.on('close', () => {
      if (!responseDone && !res.writableEnded) {
        responseDone = true;
        if (keepAlive) clearInterval(keepAlive);
        controller.abort();
      }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(converter.buildRoleChunk(cursorModel));
    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15000);

    let streamedText = '';
    try {
      const result = await runTurn({
        stream: true,
        signal: controller.signal,
        onDelta: (text) => {
          streamedText += text;
          if (!responseDone && !res.writableEnded) {
            res.write(converter.buildStreamChunk(text, cursorModel));
          }
        },
      });

      if (result.type === 'tool_calls') {
        finishToolCalls(result.toolCalls);
        console.log(`  🛠️  stream paused for tool_calls: ${result.toolCalls.map(tc => tc.name).join(', ')}`);
        return;
      }

      if (result.error && !responseDone && !res.writableEnded) {
        res.write(converter.buildStreamChunk(`\n\n[Error: ${result.error}]`, cursorModel));
      }

      finishStream();
      if (result.error) {
        console.log(`  ⚠️ stream finished with error: ${result.error} | in=${result.inputTokens} out=${result.outputTokens}`);
      } else {
        console.log(`  ✅ stream done | in=${result.inputTokens} out=${result.outputTokens} out_len=${streamedText.length}字符`);
      }
    } catch (e) {
      if (e.message === 'Request aborted') {
        console.log('  ⚠️ stream aborted by client');
      } else {
        console.error(`  ❌ stream error: ${e.message}`);
        if (!responseDone && !res.writableEnded) {
          res.write(converter.buildStreamChunk(`\n\n[Error: ${e.message}]`, cursorModel));
        }
        finishStream();
      }
      if (keepAlive) clearInterval(keepAlive);
    }

  } else {
    // ── 非流式响应 ──
    try {
      const result = await runTurn({ stream: false });

      if (result.type === 'tool_calls') {
        console.log(`  🛠️  paused for tool_calls: ${result.toolCalls.map(tc => tc.name).join(', ')}`);
        return res.json(converter.buildToolCallChatResponse(result.toolCalls, cursorModel));
      }

      if (result.error) {
        console.error(`  ❌ ${result.error}`);
        return res.status(500).json(converter.buildErrorResponse(result.error));
      }

      console.log(`  ✅ done | in=${result.inputTokens} out=${result.outputTokens} out_len=${result.text.length}字符`);
      res.json(converter.buildChatResponse(result.text, cursorModel, result.inputTokens, result.outputTokens));
    } catch (e) {
      console.error(`  ❌ ${e.message}`);
      res.status(500).json(converter.buildErrorResponse(e.message));
    }
  }
});

// ── 健康检查 ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tokens: tokens.length,
    defaultModel: DEFAULT_MODEL,
    version: '2.0.0',
  });
});

// ── 启动 ──
const count = loadTokens();
watchTokenFile();

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║       CursorIDE2API v2.0 (Lite)           ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  🌐 http://${HOST}:${PORT}                     ║`);
  console.log(`  ║  🔌 /v1/chat/completions                  ║`);
  console.log(`  ║  📋 /v1/models                            ║`);
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  🔑 Tokens: ${String(count).padEnd(30)}║`);
  console.log(`  ║  🤖 Default: ${DEFAULT_MODEL.padEnd(29)}║`);
  console.log(`  ║  🔐 API Key: ${(API_KEY ? 'SET' : 'OPEN (no key)').padEnd(29)}║`);
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
  if (BRIDGE_TOOLS) {
    const shellNote = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_SHELL || '')
      ? 'write + shell 均交还客户端本地执行 (shell 会弹出确认框, 需客户端支持)'
      : 'write 交还客户端本地执行 (shell 未桥接; 设 BRIDGE_SHELL=1 可让客户端弹确认框后自己执行)';
    console.log(`  🛠️  tool_calls 桥接已开启 (${shellNote}, 如 VSCode Copilot)`);
    console.log('');
  }
  if (/^(1|true|yes|on)$/i.test(process.env.ENABLE_SHELL || '')) {
    const bridged = BRIDGE_TOOLS && /^(1|true|yes|on)$/i.test(process.env.BRIDGE_SHELL || '');
    console.log(`  ⚠️  ENABLE_SHELL 已开启: 模型可在本机真实执行 shell 命令 (等同于给模型 shell 权限)${bridged ? ', 仅在没有走桥接确认时才会用到' : ''}`);
    console.log('');
  }
});

// ── 优雅退出 ──
process.on('SIGINT', () => { console.log('\n  Bye!'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
