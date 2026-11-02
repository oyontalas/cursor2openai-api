// ═══════════════════════════════════════════════
//  CursorIDE2API - Cursor API 客户端
//  基于 agent.v1.AgentService/Run BiDi 协议
// ═══════════════════════════════════════════════

const http2 = require('http2');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// ── Checksum 生成 ──
function generateChecksum(machineId, macMachineId) {
  let k = 165;
  const t = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255,
    (t >> 16) & 255, (t >> 8) & 255, t & 255,
  ]);
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ k) + (i % 256)) & 0xFF;
    k = b[i];
  }
  const prefix = Buffer.from(b).toString('base64');
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}

// ── Envelope 帧编码 ──
function encodeFrame(obj) {
  const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.alloc(5 + jsonBuf.length);
  frame[0] = 0;
  frame.writeUInt32BE(jsonBuf.length, 1);
  jsonBuf.copy(frame, 5);
  return frame;
}

// 把 Node 的 process.platform/arch 映射成 Cursor 桌面客户端真实会发的取值
// (来自对 workbench.desktop.main.js 的逆向: x-cursor-client-os 用 windows_nt/darwin/linux)
const CLIENT_OS = process.platform === 'win32' ? 'windows_nt' : process.platform === 'darwin' ? 'darwin' : 'linux';
const CLIENT_ARCH = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;

// ── 构建请求头 ──
function buildHeaders(token) {
  return {
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'content-type': 'application/connect+json',
    'connect-protocol-version': '1',
    'authorization': `Bearer ${token.accessToken}`,
    'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
    'x-cursor-client-version': config.cursor.clientVersion,
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-request-id': uuidv4(),
    // 以下是真实 Cursor 桌面客户端也会带的可选头 (非必需, 但更贴近真实 IDE 流量指纹)
    'x-cursor-client-type': 'ide',
    'x-cursor-client-os': CLIENT_OS,
    'x-cursor-client-arch': CLIENT_ARCH,
    'x-cursor-client-device-type': 'desktop',
  };
}

const STREAM_FIRST_CHUNK_BASE_MS = parseInt(process.env.STREAM_FIRST_CHUNK_TIMEOUT || '90000');
const STREAM_FIRST_CHUNK_MAX_MS = parseInt(process.env.STREAM_FIRST_CHUNK_TIMEOUT_MAX || '300000');
const STREAM_FIRST_CHUNK_MS_PER_CHAR = parseFloat(process.env.STREAM_FIRST_CHUNK_MS_PER_CHAR || '2');

function computeFirstChunkTimeoutMs(promptLength) {
  const adaptive = STREAM_FIRST_CHUNK_BASE_MS + Math.round((promptLength || 0) * STREAM_FIRST_CHUNK_MS_PER_CHAR);
  return Math.min(adaptive, STREAM_FIRST_CHUNK_MAX_MS);
}

function destroySession(session) {
  if (session.destroyed) return;
  session.destroyed = true;
  if (session.heartbeat) clearInterval(session.heartbeat);
  if (session.firstChunkTimer) clearTimeout(session.firstChunkTimer);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try { session.req.close(http2.constants.NGHTTP2_CANCEL); } catch {}
  try { session.req.destroy(); } catch {}
  setTimeout(() => {
    try { session.client.close(); } catch {}
    try { session.client.destroy(); } catch {}
  }, 50);
}

// 仅在尚未收到文本的连接失败时重试。
const CONNECT_RETRY_COUNT = parseInt(process.env.CONNECT_RETRY_COUNT || '2');
const CONNECT_RETRY_DELAY_MS = parseInt(process.env.CONNECT_RETRY_DELAY_MS || '600');

function chat(token, prompt, modelId, options = {}) {
  const {
    conversationId = uuidv4(),
    stream = false,
    onDelta = null,        // (text) => void
    onThinking = null,     // (text) => void
    signal = null,         // AbortSignal
    firstChunkTimeoutMs = stream ? computeFirstChunkTimeoutMs(prompt.length) : 0,
    idleTimeoutMs = stream ? parseInt(process.env.STREAM_IDLE_TIMEOUT || '60000') : 0,
  } = options;

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let abortedByCaller = false;

    if (signal) {
      if (signal.aborted) return reject(new Error('Request aborted'));
      signal.addEventListener('abort', () => { abortedByCaller = true; }, { once: true });
    }

    function startAttempt() {
      attempt++;
      let client;
      try {
        client = http2.connect(config.cursor.baseUrl);
      } catch (e) {
        return maybeRetryOrReject(null, e);
      }

      client.on('error', (e) => {
        // Suppress unhandled errors after cleanup
      });

      const req = client.request(buildHeaders(token));
      // 流式响应由首字和空闲计时器控制。
      req.setTimeout(stream ? 0 : config.cursor.requestTimeout);

      const session = {
        id: conversationId,
        client, req,
        fullText: '', thinkingText: '', inputTokens: 0, outputTokens: 0, thinkingMs: 0,
        buffer: Buffer.alloc(0),
        destroyed: false,
        settled: false,
        errorMsg: '',
        sawTextDelta: false,
        firstChunkTimer: null,
        idleTimer: null,
        heartbeat: null,
        resolve, reject,
        onDelta, onThinking,
        firstChunkTimeoutMs, idleTimeoutMs,
      };

      // 拦下"连接层面的失败" (req 的 error/timeout 事件), 判断是纯网络问题 (还没有任何真实
      // 进展) 就自动重试, 否则才走正常的 finishSession 失败流程。
      session.onConnectFailure = (e) => maybeRetryOrReject(session, e);

      wireSession(session);

      if (signal) {
        if (signal.aborted) return rejectSessionOnce(session, new Error('Request aborted'));
        signal.addEventListener('abort', () => rejectSessionOnce(session, new Error('Request aborted')), { once: true });
      }

      // ━━━ 发送 runRequest ━━━
      sendFrame(session, {
        runRequest: {
          conversationState: {},
          action: {
            userMessageAction: {
              userMessage: { text: prompt },
            },
          },
          modelDetails: {
            modelId,
            displayName: modelId,
            displayNameShort: modelId,
          },
          requestedModel: { modelId },
          conversationId,
        },
      });
    }

    // session 为 null 代表 http2.connect() 本身就同步抛错的情况 (还没有 session 可清理)
    function maybeRetryOrReject(session, e) {
      const hasRealProgress = session && (session.sawTextDelta || session.fullText);
      if (session && !session.destroyed) destroySession(session);
      if (abortedByCaller) return; // 调用方已经放弃, 不需要再重试或报错
      if (!hasRealProgress && attempt < 1 + CONNECT_RETRY_COUNT) {
        console.log(`  ↻ 连接 Cursor 失败 (${e.message}), ${CONNECT_RETRY_DELAY_MS}ms 后重试第 ${attempt + 1}/${1 + CONNECT_RETRY_COUNT} 次`);
        setTimeout(startAttempt, CONNECT_RETRY_DELAY_MS);
        return;
      }
      reject(new Error(`Connection failed: ${e.message}`));
    }

    startAttempt();
  });
}

// 写入上游协议帧
function sendFrame(session, obj) {
  if (session.destroyed) { console.error('  [upstream] skip write after destroyed:', Object.keys(obj)[0]); return; }
  try {
    session.req.write(encodeFrame(obj));
  } catch (e) {
    console.error('  [upstream] write frame failed:', e.message, Object.keys(obj)[0]);
  }
}

function clearLegTimers(session) {
  if (session.firstChunkTimer) { clearTimeout(session.firstChunkTimer); session.firstChunkTimer = null; }
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
}

function resetIdleTimer(session) {
  if (!session.idleTimeoutMs) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.fullText) finishSession(session);
    else failSession(session, 'No response from Cursor');
  }, session.idleTimeoutMs);
}

// 把当前这一段结果交还调用方, 并彻底结束整个 Cursor 会话
function finishSession(session) {
  if (session.settled) return;
  session.settled = true;
  clearLegTimers(session);
  const resolveFn = session.resolve;
  destroySession(session);
  resolveFn({
    type: 'final',
    text: session.fullText,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    thinkingMs: session.thinkingMs,
    error: session.errorMsg || null,
  });
}

function failSession(session, message) {
  if (session.settled) return;
  session.errorMsg = message;
  finishSession(session);
}

function rejectSessionOnce(session, error) {
  if (session.settled) return;
  session.settled = true;
  destroySession(session);
  session.reject(error);
}

function wireSession(session) {
  // 心跳
  session.heartbeat = setInterval(() => {
    sendFrame(session, { clientHeartbeat: {} });
  }, config.cursor.heartbeatInterval);

  if (session.firstChunkTimeoutMs) {
    session.firstChunkTimer = setTimeout(() => failSession(session, 'First stream chunk timeout'), session.firstChunkTimeoutMs);
  }
  resetIdleTimer(session);

  session.req.on('response', (headers) => {
    const status = headers[':status'];
    if (status && status !== 200) {
      let detail = `Cursor returned HTTP ${status}`;
      const grpc = headers['grpc-status'];
      const msg = headers['grpc-message'];
      if (grpc) detail += ` (grpc-status: ${grpc}${msg ? `, ${decodeURIComponent(msg)}` : ''})`;
      failSession(session, detail);
    }
  });

  session.req.on('data', (chunk) => {
    if (session.destroyed) return;
    session.buffer = Buffer.concat([session.buffer, chunk]);

    let offset = 0;
    while (offset + 5 <= session.buffer.length) {
      const len = session.buffer.readUInt32BE(offset + 1);
      if (offset + 5 + len > session.buffer.length) break;
      const s = session.buffer.slice(offset + 5, offset + 5 + len).toString('utf8');
      offset += 5 + len;

      try {
        const msg = JSON.parse(s);

        // heartbeat 不刷新 idle timer, 只有业务 frame 才续命
        const isHeartbeatFrame = msg.interactionUpdate &&
          msg.interactionUpdate.heartbeat !== undefined &&
          Object.keys(msg.interactionUpdate).length === 1;
        if (!isHeartbeatFrame) resetIdleTimer(session);

        // 错误
        if (msg.error) {
          let detail = '';
          if (msg.error.details?.[0]?.value) {
            try { detail = Buffer.from(msg.error.details[0].value, 'base64').toString('utf8'); } catch {}
          }
          session.errorMsg = detail || msg.error.message || msg.error.code || 'Unknown error';
          finishSession(session);
          return;
        }

        // 仅回复协议所需的环境信息，所有工具执行请求均终止并返回错误。
        if (msg.execServerMessage) {
          const exec = msg.execServerMessage;
          if (exec.requestContextArgs && !Object.keys(exec).some(key => key.endsWith('Args') && key !== 'requestContextArgs')) {
            sendFrame(session, { execClientMessage: {
              id: exec.id ?? 0, execId: exec.execId || '',
              requestContextResult: { success: { requestContext: { env: {
                operatingSystem: process.platform === 'win32' ? 'windows' : process.platform,
                defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
              } } } },
            } });
            continue;
          }
          failSession(session, 'Upstream requested a tool; tool execution is not supported');
          return;
        }

        // KV (忽略, 不需要处理)
        if (msg.kvServerMessage) continue;

        // InteractionUpdate
        if (msg.interactionUpdate) {
          const iu = msg.interactionUpdate;

          // 心跳
          if (iu.heartbeat !== undefined) continue;

          // 文本增量
          if (iu.textDelta) {
            const t = typeof iu.textDelta === 'string' ? iu.textDelta : (iu.textDelta.text || iu.textDelta.delta || '');
            if (t) {
              session.sawTextDelta = true;
              if (session.firstChunkTimer) { clearTimeout(session.firstChunkTimer); session.firstChunkTimer = null; }
              session.fullText += t;
              if (session.onDelta) session.onDelta(t);
            }
            continue;
          }

          // 思考增量
          if (iu.thinkingDelta) {
            const t = iu.thinkingDelta.text || iu.thinkingDelta.delta || '';
            if (t && session.onThinking) {
              session.thinkingText += t;
              session.onThinking(t);
            }
            continue;
          }

          // 思考完成
          if (iu.thinkingCompleted) {
            session.thinkingMs = iu.thinkingCompleted.thinkingDurationMs || 0;
            continue;
          }

          // 回合结束
          if (iu.turnEnded) {
            session.inputTokens = parseInt(iu.turnEnded.inputTokens || '0');
            session.outputTokens = parseInt(iu.turnEnded.outputTokens || '0');
            finishSession(session);
            return;
          }

          // Token 增量
          if (iu.tokenDelta) continue;
          if (iu.stepCompleted) continue;

          // message 嵌套的情况
          const m = iu.message;
          if (m) {
            if (m.textDelta) {
              const t = typeof m.textDelta === 'string' ? m.textDelta : (m.textDelta.text || m.textDelta.delta || '');
              if (t) {
                session.sawTextDelta = true;
                if (session.firstChunkTimer) { clearTimeout(session.firstChunkTimer); session.firstChunkTimer = null; }
                session.fullText += t;
                if (session.onDelta) session.onDelta(t);
              }
            }
            if (m.turnEnded) {
              session.inputTokens = parseInt(m.turnEnded.inputTokens || '0');
              session.outputTokens = parseInt(m.turnEnded.outputTokens || '0');
              finishSession(session);
              return;
            }
            if (m.thinkingCompleted) {
              session.thinkingMs = m.thinkingCompleted.thinkingDurationMs || 0;
            }
          }

          continue;
        }

        // Checkpoint, InteractionQuery 等忽略
        if (msg.conversationCheckpointUpdate) continue;
        if (msg.interactionQuery) continue;

      } catch {}
    }
    session.buffer = session.buffer.slice(offset);
  });

  session.req.on('end', () => {
    if (session.settled || session.destroyed) return;
    if (session.sawTextDelta) finishSession(session);
    else failSession(session, 'Stream ended without content');
  });
  session.req.on('close', () => { if (!session.settled && !session.destroyed && session.sawTextDelta) finishSession(session); });
  session.req.on('error', (e) => {
    if (session.destroyed) return;
    // 还没有任何真实进展的连接层失败 (比如 TLS 握手中途被打断) 交给 chat() 里的重试逻辑处理,
    // 不当成"这一段对话失败"直接 resolve 出去。
    if (!session.settled && !session.sawTextDelta && !session.fullText && session.onConnectFailure) {
      return session.onConnectFailure(e);
    }
    session.errorMsg = e.message;
    finishSession(session);
  });
  session.req.on('timeout', () => {
    if (session.destroyed) return;
    if (!session.settled && !session.sawTextDelta && !session.fullText && session.onConnectFailure) {
      return session.onConnectFailure(new Error('Request timeout'));
    }
    session.errorMsg = 'Request timeout';
    finishSession(session);
  });
}

/**
 * 获取可用模型列表
 */
function getModels(token) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(config.cursor.baseUrl);
    client.on('error', () => {});
    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/GetUsableModels',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'authorization': `Bearer ${token.accessToken}`,
      'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
      'x-cursor-client-version': config.cursor.clientVersion,
      'x-request-id': uuidv4(),
    });
    req.setTimeout(15000);
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      client.close();
      try { resolve(JSON.parse(body)); } catch { resolve({ models: [] }); }
    });
    req.on('error', e => { client.close(); reject(e); });
    req.on('timeout', () => { req.close(); client.close(); reject(new Error('Timeout')); });
    req.write(JSON.stringify({}));
    req.end();
  });
}

module.exports = { chat, getModels };
