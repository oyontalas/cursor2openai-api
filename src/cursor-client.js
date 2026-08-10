// ═══════════════════════════════════════════════
//  CursorIDE2API - Cursor API 客户端
//  基于 agent.v1.AgentService/Run BiDi 协议
// ═══════════════════════════════════════════════

const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

// ── 安全工具 (限 workspace 内) ──
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || process.cwd());
const MAX_READ_BYTES = parseInt(process.env.CURSOR_TOOL_MAX_READ_BYTES || '120000');
const MAX_LIST_ENTRIES = parseInt(process.env.CURSOR_TOOL_MAX_LIST_ENTRIES || '200');

// 写/删默认关闭, 需显式开启 (会真实操作服务器上的 WORKSPACE_ROOT)
const ENABLE_WRITE = /^(1|true|yes|on)$/i.test(process.env.ENABLE_WRITE || '');

// shell 的 tool_calls 桥接: 让 VSCode/Copilot 弹出原生确认框, 客户端确认后在自己的终端真实执行。
// Cursor 后端收到执行结果后不会正常结束这次工具调用 (只发心跳), 但配合下面 armShellFallback
// 兜底 (等 SHELL_FALLBACK_GRACE_MS 后用已拿到的真实结果收尾) 已端到端验证可用。默认关闭,
// 需要同时开 BRIDGE_TOOLS=1。
const BRIDGE_SHELL = /^(1|true|yes|on)$/i.test(process.env.BRIDGE_SHELL || '');

// 在代理服务器本机真实执行 shell 命令, 不弹确认框 (需显式开启, 默认关闭, 等同于给模型服务器
// shell 权限, 有风险)。同样配合 armShellFallback 兜底。调用方声明了 tools 且 BRIDGE_SHELL=1
// 时优先走上面的桥接 (体验更好); 否则 (比如直接用 curl/SDK, 没有走带确认框的客户端) 才会用这里。
const ENABLE_SHELL = /^(1|true|yes|on)$/i.test(process.env.ENABLE_SHELL || '');
const SHELL_TIMEOUT_MS = parseInt(process.env.SHELL_TIMEOUT_MS || '120000');
const SHELL_MAX_OUTPUT_BYTES = parseInt(process.env.SHELL_MAX_OUTPUT_BYTES || '200000');

// 首字超时: 实测 "放弃卡死会话, 带完整历史开新会话续接" 场景下, prompt 会随着工具调用轮数
// 越滚越大 (曾在一次 arxiv-paper-qa 任务里从 28K 字符涨到 46K 字符), Cursor 后端处理这么长的
// prompt、给出第一个响应字符所需时间也随之变长, 固定 60s 首字超时在长 prompt 下会被真实触发
// (报错 "First stream chunk timeout"), 把整段 agent 对话强行截断。这里改成随 prompt 长度自适应
// 拉长超时上限 (同时设置绝对上限, 避免调用方一直挂着白等)。
const STREAM_FIRST_CHUNK_BASE_MS = parseInt(process.env.STREAM_FIRST_CHUNK_TIMEOUT || '90000');
const STREAM_FIRST_CHUNK_MAX_MS = parseInt(process.env.STREAM_FIRST_CHUNK_TIMEOUT_MAX || '300000');
const STREAM_FIRST_CHUNK_MS_PER_CHAR = parseFloat(process.env.STREAM_FIRST_CHUNK_MS_PER_CHAR || '2');

function computeFirstChunkTimeoutMs(promptLength) {
  const adaptive = STREAM_FIRST_CHUNK_BASE_MS + Math.round((promptLength || 0) * STREAM_FIRST_CHUNK_MS_PER_CHAR);
  return Math.min(adaptive, STREAM_FIRST_CHUNK_MAX_MS);
}

// shell 的 cwd 有意不像 read/write 那样限制在 WORKSPACE_ROOT 内: 开 ENABLE_SHELL 本身就等于
// 给了模型完整本机 shell 权限 (脚本内 cd/读写任意路径都拦不住), 限制 cwd 只会导致真实客户端
// (如 VSCode) 传来的实际工作目录被静默改写成 WORKSPACE_ROOT, 命令跑错地方却毫无提示。
function resolveShellCwd(requested) {
  const raw = String(requested || '').trim();
  if (raw) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(WORKSPACE_ROOT, raw);
    try { if (fs.statSync(abs).isDirectory()) return abs; } catch {}
  }
  return WORKSPACE_ROOT;
}

function safePath(inputPath = '') {
  const raw = String(inputPath || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(WORKSPACE_ROOT, raw));
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) return null;
  return resolved;
}

function relPath(absPath) {
  return path.relative(WORKSPACE_ROOT, absPath) || '.';
}

function readFileTool(args = {}) {
  const requestedPath = args.path || args.filePath || args.absPath || '';
  const absPath = safePath(requestedPath);
  if (!absPath) return { rejected: { path: requestedPath, reason: 'Path outside workspace' } };
  let stat;
  try { stat = fs.statSync(absPath); } catch { return { fileNotFound: { path: requestedPath } }; }
  if (!stat.isFile()) return { invalidFile: { path: requestedPath, reason: 'Not a file' } };
  const truncated = stat.size > MAX_READ_BYTES;
  const buf = fs.readFileSync(absPath);
  const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
  const content = slice.toString('utf8');
  return {
    success: {
      path: absPath,
      content,
      totalLines: content ? content.split('\n').length : 0,
      fileSize: String(stat.size),
      truncated,
      rangeApplied: false,
    },
  };
}

function listDirTool(args = {}) {
  const requestedPath = args.path || args.directory || args.absPath || '.';
  const absPath = safePath(requestedPath);
  if (!absPath) return { rejected: { path: requestedPath, reason: 'Path outside workspace' } };
  let entries;
  try { entries = fs.readdirSync(absPath, { withFileTypes: true }); } catch (e) { return { error: { path: requestedPath, error: e.message } }; }
  const dirs = [], files = [];
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      dirs.push({ absPath: path.join(absPath, entry.name), childrenDirs: [], childrenFiles: [], childrenWereProcessed: false, fullSubtreeExtensionCounts: {}, numFiles: 0 });
    } else if (entry.isFile()) {
      files.push({ name: entry.name });
    }
  }
  return {
    success: {
      directoryTreeRoot: {
        absPath,
        childrenDirs: dirs,
        childrenFiles: files,
        childrenWereProcessed: true,
        fullSubtreeExtensionCounts: {},
        numFiles: files.length,
      },
    },
  };
}

function globToRegExp(glob) {
  const escaped = String(glob || '**/*')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function walkFiles(root, out = []) {
  if (out.length >= MAX_LIST_ENTRIES) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (out.length >= MAX_LIST_ENTRIES) break;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function grepTool(args = {}) {
  const pattern = args.pattern || args.query || args.globPattern || '';
  const requestedPath = args.path || args.directory || '.';
  const absPath = safePath(requestedPath);
  if (!absPath) return { error: { error: 'Path outside workspace' } };
  const searchRoot = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : WORKSPACE_ROOT;
  const files = walkFiles(searchRoot)
    .map(file => relPath(file))
    .filter(file => {
      if (args.globPattern) return globToRegExp(args.globPattern).test(file);
      if (!pattern || pattern === '**/*') return true;
      try {
        const content = fs.readFileSync(path.join(WORKSPACE_ROOT, file), 'utf8');
        return content.toLowerCase().includes(String(pattern).toLowerCase());
      } catch { return false; }
    })
    .slice(0, MAX_LIST_ENTRIES);
  return {
    success: {
      pattern: pattern || args.globPattern || '',
      path: requestedPath,
      outputMode: args.outputMode || 'files',
      workspaceResults: {
        [WORKSPACE_ROOT]: {
          files: { files, totalFiles: files.length, clientTruncated: files.length >= MAX_LIST_ENTRIES, ripgrepTruncated: false },
        },
      },
    },
  };
}

// ── 写文件 (需 ENABLE_WRITE=1) ──
function writeFileTool(args = {}) {
  const requestedPath = args.path || args.filePath || args.absPath || args.relativeWorkspacePath || '';
  const content = args.contents ?? args.content ?? args.text ?? args.fileText ?? args.newContent ?? args.newText ?? '';
  if (!ENABLE_WRITE) return { error: { path: requestedPath, error: 'Write disabled. Start server with ENABLE_WRITE=1 to allow file writes.' } };
  const absPath = safePath(requestedPath);
  if (!absPath) return { error: { path: requestedPath, error: 'Path outside workspace' } };
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, typeof content === 'string' ? content : String(content), 'utf8');
    return { success: {} };
  } catch (e) {
    return { error: { path: requestedPath, error: e.message } };
  }
}

// ── 删除文件 (需 ENABLE_WRITE=1) ──
function deleteFileTool(args = {}) {
  const requestedPath = args.path || args.filePath || args.absPath || args.relativeWorkspacePath || '';
  if (!ENABLE_WRITE) return { error: { path: requestedPath, error: 'Delete disabled. Start server with ENABLE_WRITE=1 to allow file deletes.' } };
  const absPath = safePath(requestedPath);
  if (!absPath) return { error: { path: requestedPath, error: 'Path outside workspace' } };
  if (absPath === WORKSPACE_ROOT) return { error: { path: requestedPath, error: 'Refusing to delete workspace root' } };
  try {
    fs.rmSync(absPath, { recursive: true, force: true });
    return { success: {} };
  } catch (e) {
    return { error: { path: requestedPath, error: e.message } };
  }
}

// ── 在服务器本机真实执行 shell 命令 (需 ENABLE_SHELL=1) ──
// isStream=true 时用 agent.v1.ShellStream 的增量协议 (start/stdout/stderr/exit),
// isStream=false 时用 agent.v1.ShellResult 的一次性协议 (success/failure/timeout/spawnError)。
// 两者的字段名都已通过反查 Cursor 桌面客户端 workbench.desktop.main.js 精确核对。
function formatShellFallbackText(command, cwd, code, stdout, stderr, aborted) {
  const parts = [`已在服务器本机 (${cwd}) 真实执行命令: \`${command}\``, `退出码: ${code}${aborted ? ' (被终止: 超时或输出过大)' : ''}`];
  if (stdout) parts.push(`stdout:\n\`\`\`\n${stdout}\n\`\`\``);
  if (stderr) parts.push(`stderr:\n\`\`\`\n${stderr}\n\`\`\``);
  if (!stdout && !stderr) parts.push('(无输出)');
  return parts.join('\n\n');
}

function runShellReal({ writeFrame, id, execId, args = {}, isStream, session = null }) {
  const command = String(args.command || '');
  const cwd = resolveShellCwd(args.workingDirectory);
  const requestedTimeout = parseInt(args.timeout || 0, 10) || 0;
  const timeoutMs = requestedTimeout > 0 ? Math.min(requestedTimeout, SHELL_TIMEOUT_MS) : SHELL_TIMEOUT_MS;

  if (!ENABLE_SHELL) {
    const reason = 'Shell execution disabled. Start server with ENABLE_SHELL=1 to allow the model to run real commands on this machine.';
    if (isStream) {
      writeFrame({ execClientMessage: { id, execId, shellStream: { start: {} } } });
      writeFrame({ execClientMessage: { id, execId, shellStream: { rejected: { command, workingDirectory: cwd, reason, isReadonly: true } } } });
      writeFrame({ execClientMessage: { id, execId, shellStream: { exit: { code: 1, cwd, aborted: false } } } });
    } else {
      writeFrame({ execClientMessage: { id, execId, shellResult: { rejected: { command, workingDirectory: cwd, reason, isReadonly: true } } } });
    }
    return;
  }

  if (!command.trim()) {
    if (isStream) {
      writeFrame({ execClientMessage: { id, execId, shellStream: { start: {} } } });
      writeFrame({ execClientMessage: { id, execId, shellStream: { exit: { code: 0, cwd, aborted: false } } } });
    } else {
      writeFrame({ execClientMessage: { id, execId, shellResult: { success: { command, workingDirectory: cwd, exitCode: 0, signal: '', stdout: '', stderr: '', executionTime: 0 } } } });
    }
    armShellFallback(session, formatShellFallbackText(command, cwd, 0, '', '', false));
    return;
  }

  const start = Date.now();
  let stdoutBuf = '', stderrBuf = '', outBytes = 0;
  let killedForTimeout = false, killedForSize = false, settled = false;
  let child;

  try {
    child = spawn(command, { shell: true, cwd, env: process.env, windowsHide: true });
  } catch (e) {
    if (isStream) {
      writeFrame({ execClientMessage: { id, execId, shellStream: { start: {} } } });
      writeFrame({ execClientMessage: { id, execId, shellStream: { exit: { code: 127, cwd, aborted: false } } } });
    } else {
      writeFrame({ execClientMessage: { id, execId, shellResult: { spawnError: { command, workingDirectory: cwd, error: e.message } } } });
    }
    armShellFallback(session, `执行命令 \`${command}\` 失败, 无法启动进程: ${e.message}`);
    return;
  }

  if (isStream) writeFrame({ execClientMessage: { id, execId, shellStream: { start: {} } } });

  const timer = setTimeout(() => {
    killedForTimeout = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);

  const onOutput = (chunk, isErr) => {
    outBytes += chunk.length;
    if (outBytes > SHELL_MAX_OUTPUT_BYTES) {
      if (!killedForSize) { killedForSize = true; try { child.kill('SIGKILL'); } catch {} }
      return;
    }
    const text = chunk.toString('utf8');
    if (isErr) stderrBuf += text; else stdoutBuf += text;
    if (isStream) {
      writeFrame({ execClientMessage: { id, execId, shellStream: isErr ? { stderr: { data: text } } : { stdout: { data: text } } } });
    }
  };
  child.stdout?.on('data', (chunk) => onOutput(chunk, false));
  child.stderr?.on('data', (chunk) => onOutput(chunk, true));

  child.on('error', (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (isStream) {
      writeFrame({ execClientMessage: { id, execId, shellStream: { exit: { code: 127, cwd, aborted: false } } } });
    } else {
      writeFrame({ execClientMessage: { id, execId, shellResult: { spawnError: { command, workingDirectory: cwd, error: e.message } } } });
    }
    armShellFallback(session, `执行命令 \`${command}\` 失败: ${e.message}`);
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const localExecutionTimeMs = Date.now() - start;
    const aborted = killedForTimeout || killedForSize;
    const exitCode = code == null ? (aborted ? -1 : 1) : code;
    const fallbackText = formatShellFallbackText(command, cwd, exitCode, stdoutBuf, stderrBuf, aborted);

    if (isStream) {
      writeFrame({
        execClientMessage: {
          id, execId, localExecutionTimeMs,
          shellStream: { exit: { code: code == null ? 1 : code, cwd, aborted, localExecutionTimeMs } },
        },
      });
      armShellFallback(session, fallbackText);
      return;
    }

    if (killedForTimeout) {
      writeFrame({ execClientMessage: { id, execId, localExecutionTimeMs, shellResult: { timeout: { command, workingDirectory: cwd, timeoutMs } } } });
    } else if (!aborted && code === 0) {
      writeFrame({
        execClientMessage: {
          id, execId, localExecutionTimeMs,
          shellResult: { success: { command, workingDirectory: cwd, exitCode: code || 0, signal: signal || '', stdout: stdoutBuf, stderr: stderrBuf, executionTime: localExecutionTimeMs, localExecutionTimeMs } },
        },
      });
    } else {
      writeFrame({
        execClientMessage: {
          id, execId, localExecutionTimeMs,
          shellResult: { failure: { command, workingDirectory: cwd, exitCode: code == null ? -1 : code, signal: signal || '', stdout: stdoutBuf, stderr: stderrBuf, executionTime: localExecutionTimeMs, aborted, localExecutionTimeMs } },
        },
      });
    }
    armShellFallback(session, fallbackText);
  });
}

// ── 处理 ExecServerMessage ──

// tool_calls 桥接: 把 Cursor 的 write/shell exec 请求翻译成 OpenAI tool_calls,
// 交给真正的客户端 (如 VSCode Copilot) 在本地执行, 而不是在服务器上执行/拒绝。
// 工具名对齐 GitHub Copilot Chat 声明的真实工具 (create_file / run_in_terminal)。
function toToolCallId() {
  return 'call_' + uuidv4().replace(/-/g, '').slice(0, 24);
}

function buildBridgeToolCall(kind, args) {
  if (kind === 'write') {
    const filePath = args.path || args.filePath || args.absPath || args.relativeWorkspacePath || '';
    const content = args.contents ?? args.content ?? args.text ?? args.fileText ?? args.newContent ?? args.newText ?? '';
    return { name: 'create_file', arguments: JSON.stringify({ filePath, content }) };
  }
  if (kind === 'shell' || kind === 'shellStream') {
    const command = args.command || '';
    const explanation = args.description || command || 'Run command';
    return { name: 'run_in_terminal', arguments: JSON.stringify({ command, explanation, isBackground: false }) };
  }
  return null;
}

// 处理一条 ExecServerMessage。
// session 为空 (legacy 调用) 时行为与旧版完全一致。
// session.bridgeTools 为 true 时, write/shell 会暂停会话, 转换成 tool_calls 交还调用方。
function handleExecMessage(exec, writeFrame, session = null) {
  const { id = 0, execId = '' } = exec;

  if (exec.requestContextArgs) {
    writeFrame({
      execClientMessage: {
        id, execId,
        requestContextResult: {
          success: {
            requestContext: {
              env: {
                operatingSystem: process.platform === 'win32' ? 'windows' : process.platform,
                defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
              },
            },
          },
        },
      },
    });
    return 'requestContext';
  }

  if (exec.readArgs) {
    writeFrame({ execClientMessage: { id, execId, readResult: readFileTool(exec.readArgs) } });
    return 'read';
  }

  if (exec.lsArgs) {
    writeFrame({ execClientMessage: { id, execId, lsResult: listDirTool(exec.lsArgs) } });
    return 'ls';
  }

  if (exec.shellStreamArgs) {
    const a = exec.shellStreamArgs || {};
    const cwd = a.workingDirectory || a.args?.workingDirectory || WORKSPACE_ROOT;
    // 优先走桥接 (BRIDGE_SHELL): 能让 VSCode/Copilot 弹出原生的"允许执行此命令?"确认框,
    // 命令也在客户端自己的终端里真实执行, 体验上更贴近原生 Agent。命令结果拿到后仍会用
    // armShellFallback 兜底收尾 (Cursor 后端目前不认可我们的 exit 回复, 见 README)。
    if (session && session.bridgeTools && BRIDGE_SHELL) {
      const toolCallId = toToolCallId();
      const toolCall = buildBridgeToolCall('shellStream', a);
      session.pendingBridge = { toolCallId, kind: 'shellStream', id, execId, rawArgs: a };
      session.toolCallIndex.set(toolCallId, session.id);
      session.pause({ toolCalls: [{ id: toolCallId, ...toolCall }] });
      return 'bridge:shellStream';
    }
    if (ENABLE_SHELL) {
      runShellReal({ writeFrame, id, execId, args: a, isStream: true, session });
      return 'shellStream:real';
    }
    // 拒绝 shell, 但发完整事件序列: start + rejected + exit
    writeFrame({ execClientMessage: { id, execId, shellStream: { start: {} } } });
    writeFrame({ execClientMessage: { id, execId, shellStream: { rejected: { reason: 'Shell not supported in proxy mode. Set ENABLE_SHELL=1 to allow real execution, or use read/ls/grep tools instead.' } } } });
    writeFrame({ execClientMessage: { id, execId, shellStream: { exit: { code: 1, cwd } } } });
    return 'shellStream';
  }

  if (exec.shellArgs) {
    const a = exec.shellArgs || {};
    const cmd = a.command || '';
    const cwd = a.workingDirectory || WORKSPACE_ROOT;
    if (session && session.bridgeTools && BRIDGE_SHELL) {
      const toolCallId = toToolCallId();
      const toolCall = buildBridgeToolCall('shell', a);
      session.pendingBridge = { toolCallId, kind: 'shell', id, execId, rawArgs: a };
      session.toolCallIndex.set(toolCallId, session.id);
      session.pause({ toolCalls: [{ id: toolCallId, ...toolCall }] });
      return 'bridge:shell';
    }
    if (ENABLE_SHELL) {
      runShellReal({ writeFrame, id, execId, args: a, isStream: false, session });
      return 'shell:real';
    }
    writeFrame({ execClientMessage: { id, execId, shellResult: { rejected: { command: cmd, workingDirectory: cwd, reason: 'Shell not supported in proxy mode. Set ENABLE_SHELL=1 to allow real execution, or use read/ls/grep tools instead.', isReadonly: true } } } });
    return 'shell';
  }

  if (exec.grepArgs || exec.globArgs) {
    writeFrame({ execClientMessage: { id, execId, grepResult: grepTool(exec.grepArgs || exec.globArgs) } });
    return exec.globArgs ? 'glob' : 'grep';
  }

  if (exec.writeArgs) {
    const a = exec.writeArgs || {};
    if (session && session.bridgeTools) {
      const toolCallId = toToolCallId();
      const toolCall = buildBridgeToolCall('write', a);
      session.pendingBridge = { toolCallId, kind: 'write', id, execId, rawArgs: a };
      session.toolCallIndex.set(toolCallId, session.id);
      session.pause({ toolCalls: [{ id: toolCallId, ...toolCall }] });
      return 'bridge:write';
    }
    writeFrame({ execClientMessage: { id, execId, writeResult: writeFileTool(a) } });
    return 'write';
  }

  if (exec.deleteArgs) {
    writeFrame({ execClientMessage: { id, execId, deleteResult: deleteFileTool(exec.deleteArgs) } });
    return 'delete';
  }

  if (exec.diagnosticsArgs) {
    writeFrame({ execClientMessage: { id, execId, diagnosticsResult: { diagnostics: [] } } });
    return 'diagnostics';
  }

  // Unknown exec type: reject to unblock the turn
  writeFrame({ execClientMessage: { id, execId, shellResult: { rejected: { reason: 'Unsupported exec type in headless mode' } } } });
  return 'unknown';
}

// ── 会话注册表 (支持跨多次 HTTP 请求恢复同一条 Cursor 双向流) ──
const sessions = new Map();          // sessionId -> session
const toolCallOwner = new Map();     // toolCallId -> sessionId
// 桥接的 tool_calls (尤其是 shell) 交还客户端后, 通常需要真人在 IDE 里点一下"允许执行此命令?"
// 确认框才会继续——这是完全合理的、可能长达几分钟甚至更久的等待, 不是网络卡住或模型没反应,
// 不应该被当成"超时"处理掉。所以这里给得比较宽松, 而且即使真的到了这个时限也不会报错中断
// 对话 (见 armAbandonGuard 的注释), 只是用来回收长期没人确认的会话占用的内存。
const SESSION_ABANDON_MS = parseInt(process.env.BRIDGE_SESSION_TIMEOUT || '1800000'); // 默认 30 分钟无人确认则回收

function destroySession(session) {
  if (session.destroyed) return;
  session.destroyed = true;
  if (session.abandonTimer) clearTimeout(session.abandonTimer);
  if (session.heartbeat) clearInterval(session.heartbeat);
  if (session.firstChunkTimer) clearTimeout(session.firstChunkTimer);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.shellFallbackTimer) clearTimeout(session.shellFallbackTimer);
  try { session.req.close(http2.constants.NGHTTP2_CANCEL); } catch {}
  try { session.req.destroy(); } catch {}
  setTimeout(() => {
    try { session.client.close(); } catch {}
    try { session.client.destroy(); } catch {}
  }, 50);
  sessions.delete(session.id);
  if (session.pendingBridge) toolCallOwner.delete(session.pendingBridge.toolCallId);
}

// 注意: 这个计时器到点后只是 destroySession() 回收内存/关闭底层连接, 完全不会调用 session.resolve/
// reject —— 因为 pauseSession() 早就把 resolve/reject 交还给调用方了 (那次 HTTP 请求早已经正常
// 结束、返回了 tool_calls), 这里没有"正在等待的 Promise"可失败。等真人确认完、真的发起
// resumeToolCall() 时, 如果这个会话已经被回收, peekPendingBridgeKind 会返回 null, server.js
// 会据此自动改用"开新会话续接完整历史"兜底, 而不是报错——所以这个时限设长一点、短一点都不会
// 造成用户可见的失败, 纯粹是内存回收的时间窗口。
function armAbandonGuard(session) {
  if (session.abandonTimer) clearTimeout(session.abandonTimer);
  session.abandonTimer = setTimeout(() => {
    console.log(`  ⏱️ session ${session.id} abandoned (no tool result within ${SESSION_ABANDON_MS}ms), cleaning up`);
    destroySession(session);
  }, SESSION_ABANDON_MS);
}

// ── ENABLE_SHELL 兜底: Cursor 后端目前不会在收到我们的 shellStream/exit 回复后
// 结束这次工具调用 (哪怕命令是 100% 真实执行、真实输出、真实退出码, 依然卡住只发心跳,
// 具体协议原因未查明, 详见 README)。既然命令已经真实跑完并拿到了正确结果, 与其让调用方
// 一直等到 idle 超时报错, 不如等一小段合理宽限期后直接用本地已捕获的真实结果收尾。
const SHELL_FALLBACK_GRACE_MS = parseInt(process.env.SHELL_FALLBACK_GRACE_MS || '15000');

function armShellFallback(session, fallbackText) {
  if (!session) return;
  clearShellFallback(session);
  const seq = (session.shellFallbackSeq = (session.shellFallbackSeq || 0) + 1);
  session.shellFallbackTimer = setTimeout(() => {
    if (session.destroyed || session.settled) return;
    if (session.shellFallbackSeq !== seq) return; // 期间已有新进展, 作废
    console.log(`  ⚠️ shell 命令已真实执行完毕, 但 Cursor 会话 ${SHELL_FALLBACK_GRACE_MS}ms 内未推进 (可能是 shellStream 完结协议未打通), 使用本地捕获结果兜底收尾`);
    const prefix = session.fullText && !session.fullText.endsWith('\n') ? '\n' : '';
    session.fullText += prefix + fallbackText;
    // 流式模式下最终文本不会重新逐字推送, 必须显式走 onDelta 才能让客户端看到兜底内容
    if (session.onDelta) session.onDelta(prefix + fallbackText);
    finishSession(session);
  }, SHELL_FALLBACK_GRACE_MS);
}

function clearShellFallback(session) {
  if (session && session.shellFallbackTimer) {
    clearTimeout(session.shellFallbackTimer);
    session.shellFallbackTimer = null;
  }
}

/**
 * 调用 Cursor AgentService.Run
 * 
 * @param {Object} token - { accessToken, machineId, macMachineId }
 * @param {string} prompt - 用户消息
 * @param {string} modelId - 模型 ID
 * @param {Object} options - { conversationId, stream, onDelta, onThinking, signal, bridgeTools }
 * @returns {Promise<{ type: 'final', text, inputTokens, outputTokens, thinkingMs, error } | { type: 'tool_calls', toolCalls, sessionId }>}
 */
// 建立到 Cursor 后端的连接在真正开始交互前失败 (比如 TLS 握手途中被打断、DNS/网络抖动),
// 属于纯粹的网络问题, 跟"模型没反应"或"人还没确认"完全是两码事——重试一下往往就好了,
// 没必要直接把整个任务判失败甩给调用方去手动重试。这里只在"这次连接从头到尾没收到过任何
// 真实进展"时才允许自动重试几次, 一旦已经有过任何 sawTextDelta / pendingBridge / fullText,
// 说明连接是正常的、只是后来才出问题, 就不再重试 (避免把已经真实发生过的操作重复一遍)。
const CONNECT_RETRY_COUNT = parseInt(process.env.CONNECT_RETRY_COUNT || '2');
const CONNECT_RETRY_DELAY_MS = parseInt(process.env.CONNECT_RETRY_DELAY_MS || '600');

function chat(token, prompt, modelId, options = {}) {
  const {
    conversationId = uuidv4(),
    stream = false,
    onDelta = null,        // (text) => void
    onThinking = null,     // (text) => void
    signal = null,         // AbortSignal
    bridgeTools = false,   // true 时, write/shell exec 会转换成 tool_calls 暂停会话交还调用方执行
    firstChunkTimeoutMs = (stream || bridgeTools) ? computeFirstChunkTimeoutMs(prompt.length) : 0,
    idleTimeoutMs = (stream || bridgeTools) ? parseInt(process.env.STREAM_IDLE_TIMEOUT || '60000') : 0,
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
      // 桥接会话生命周期可能跨越多次 HTTP 请求 (等待客户端在本地执行工具), 不能设短超时
      req.setTimeout(stream || bridgeTools ? 0 : config.cursor.requestTimeout);

      const session = {
        id: conversationId,
        client, req,
        bridgeTools,
        fullText: '', thinkingText: '', inputTokens: 0, outputTokens: 0, thinkingMs: 0,
        buffer: Buffer.alloc(0),
        destroyed: false,
        settled: false,       // 当前这一段 (chat() 或某次 resumeToolCall()) 是否已经给出结果
        errorMsg: '',
        sawTextDelta: false,
        firstChunkTimer: null,
        idleTimer: null,
        heartbeat: null,
        abandonTimer: null,
        pendingBridge: null,  // { toolCallId, kind, id, execId, rawArgs }
        execQueue: [],        // 暂停等待当前 tool_calls 结果期间, 提前到达的其他 execServerMessage 排队等待
        toolCallIndex: toolCallOwner,
        resolve, reject,
        onDelta, onThinking,
        firstChunkTimeoutMs, idleTimeoutMs,
      };

      // 拦下"连接层面的失败" (req 的 error/timeout 事件), 判断是纯网络问题 (还没有任何真实
      // 进展) 就自动重试, 否则才走正常的 finishSession 失败流程。
      session.onConnectFailure = (e) => maybeRetryOrReject(session, e);

      if (bridgeTools) sessions.set(session.id, session);

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
      const hasRealProgress = session && (session.sawTextDelta || session.fullText || session.pendingBridge);
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

// 写帧辅助 (挂在 session 上, 供 handleExecMessage / 恢复调用复用)
function sendFrame(session, obj) {
  if (session.destroyed) { console.error('  [exec] skip write after destroyed:', Object.keys(obj)[0]); return; }
  try {
    session.req.write(encodeFrame(obj));
  } catch (e) {
    console.error('  [exec] write frame failed:', e.message, Object.keys(obj)[0]);
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

// 暂停当前会话, 把 tool_calls 交还调用方, 但保留底层 http2 流等待 resumeToolCall()
//
// ⚠️ clearLegTimers() 这一步很关键: firstChunkTimer/idleTimer 是用来判断"模型本身卡住没反应"的,
// 一旦进入这个暂停状态就必须清掉, 否则等真人在 IDE 里看确认框、犹豫了一会儿才点确认, 就会被
// 误判成模型没响应而报错中断整个任务——把"人还没决定"和"后端真的挂了"混为一谈。暂停期间唯一
// 生效的计时器是下面的 armAbandonGuard, 而它到点了也只是回收内存, 不会报错 (见其注释)。
function pauseSession(session, { toolCalls }) {
  if (session.settled) return;
  session.settled = true;
  clearLegTimers(session);
  const resolveFn = session.resolve;
  session.resolve = null;
  session.reject = null;
  armAbandonGuard(session);
  resolveFn({ type: 'tool_calls', toolCalls, sessionId: session.id });
}

// resumeToolCall() 把当前这个工具调用处理完、session.settled 重新变回 false 之后,
// 消费掉暂停期间排队的 exec 消息 (可能是又一个 bridge 请求, 会重新把 settled 置 true 并
// 通过这次 resumeToolCall 的 resolve 把新的 tool_calls 交还客户端; 也可能是无需桥接的
// headless 类型, 处理完继续消费队列里的下一条)。
function drainExecQueue(session) {
  while (!session.settled && !session.destroyed && session.execQueue && session.execQueue.length > 0) {
    const next = session.execQueue.shift();
    handleExecMessage(next, (obj) => sendFrame(session, obj), session);
  }
}

// 给 handleExecMessage 用: 挂到 session 上, 让它能触发暂停
function wireSession(session) {
  session.pause = (payload) => pauseSession(session, payload);

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

        // ExecServerMessage
        if (msg.execServerMessage) {
          // 新的 exec 请求本身就是真实进展 (哪怕上一个 shell 兜底还没触发), 避免用旧结果抢跑覆盖新一轮工具调用
          clearShellFallback(session);

          if (session.settled) {
            // 已经在等待前一个 tool_calls 的结果回传 (pendingBridge 还没被 resumeToolCall 消费),
            // 这时如果直接调用 handleExecMessage, bridge 分支会就地覆盖 session.pendingBridge/
            // toolCallOwner, 而 session.pause() 因为 settled=true 会静默 no-op —— 相当于把前一个
            // 还没交给客户端处理完的工具调用"偷梁换柱"掉, 之后客户端正常回传结果时会找不到对应的
            // pendingBridge, 报 "No pending tool call found" 直接把整个 agent 对话中断。
            // 正确做法是把这条 exec 消息排队, 等当前这个工具调用被 resumeToolCall() 处理完之后再消费。
            (session.execQueue = session.execQueue || []).push(msg.execServerMessage);
            session.buffer = session.buffer.slice(offset);
            return;
          }

          handleExecMessage(msg.execServerMessage, (obj) => sendFrame(session, obj), session);
          if (session.settled) {
            // 已暂停等待 tool 结果, 先把已消费的字节从缓冲区移除, 再停止处理剩余帧
            session.buffer = session.buffer.slice(offset);
            return;
          }
          continue;
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
              // 模型真的在正常说话了, 说明 shell 工具调用其实正常完结了, 不需要兜底
              clearShellFallback(session);
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
            clearShellFallback(session);
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
                clearShellFallback(session);
              }
            }
            if (m.turnEnded) {
              clearShellFallback(session);
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
    if (!session.settled && !session.sawTextDelta && !session.fullText && !session.pendingBridge && session.onConnectFailure) {
      return session.onConnectFailure(e);
    }
    session.errorMsg = e.message;
    finishSession(session);
  });
  session.req.on('timeout', () => {
    if (session.destroyed) return;
    if (!session.settled && !session.sawTextDelta && !session.fullText && !session.pendingBridge && session.onConnectFailure) {
      return session.onConnectFailure(new Error('Request timeout'));
    }
    session.errorMsg = 'Request timeout';
    finishSession(session);
  });
}

/**
 * 查一下某个 toolCallId 对应的 pendingBridge 还在不在、是什么类型 ('write' | 'shell' | 'shellStream')，
 * 不会消费/修改任何状态。用于调用方 (server.js) 决定要不要真的去 resumeToolCall() 续接原会话——
 * 已知 shell/shellStream 这条续接路径在 Cursor 后端目前是卡死的 (见 armShellFallback 处的说明),
 * 所以遇到这两种类型就不该再浪费时间去尝试原会话, 而是直接换一个全新会话。
 * 返回 null 表示已经找不到了 (会话过期/已被处理)。
 */
function peekPendingBridgeKind(toolCallId) {
  const sessionId = toolCallOwner.get(toolCallId);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.destroyed || !session.pendingBridge || session.pendingBridge.toolCallId !== toolCallId) {
    return null;
  }
  return session.pendingBridge.kind;
}

/**
 * 主动放弃一个还没被 resumeToolCall() 消费的 pendingBridge, 销毁它所在的整条 Cursor 会话。
 * 用在 "决定不再续接原会话, 改成开一个带完整历史的全新会话" 的场景, 避免旧会话继续占着
 * http2 连接和 10 分钟的弃用计时器, 白白耗资源等一个注定不会再有人来 resumeToolCall() 的结果。
 */
function discardPendingBridge(toolCallId) {
  const sessionId = toolCallOwner.get(toolCallId);
  const session = sessionId ? sessions.get(sessionId) : null;
  toolCallOwner.delete(toolCallId);
  if (session && !session.destroyed) destroySession(session);
}

/**
 * 将客户端本地执行的工具结果回传给暂停中的 Cursor 会话, 并继续等待后续事件
 * (可能是最终文本, 也可能是又一次 tool_calls 暂停)。
 *
 * @param {string} toolCallId - 对应 buildToolCallChatResponse 里返回的 tool_call.id
 * @param {string} outputText - 客户端(如 Copilot)执行工具后的结果文本
 * @param {Object} options - { stream, onDelta, onThinking, signal, isError }
 */
function resumeToolCall(toolCallId, outputText, options = {}) {
  const { onDelta = null, onThinking = null, signal = null, isError = false } = options;

  return new Promise((resolve, reject) => {
    const sessionId = toolCallOwner.get(toolCallId);
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.destroyed || !session.pendingBridge || session.pendingBridge.toolCallId !== toolCallId) {
      return reject(new Error(`No pending tool call found for id "${toolCallId}" (会话可能已过期或已被处理)`));
    }

    toolCallOwner.delete(toolCallId);
    const { kind, id, execId, rawArgs } = session.pendingBridge;
    session.pendingBridge = null;
    if (session.abandonTimer) { clearTimeout(session.abandonTimer); session.abandonTimer = null; }

    replyBridgedTool(session, kind, id, execId, rawArgs, outputText, isError);

    // 重新绑定这一段的 resolve/reject 与回调, 继续消费同一条流的后续事件
    session.resolve = resolve;
    session.reject = reject;
    session.settled = false;
    if (onDelta) session.onDelta = onDelta;
    if (onThinking) session.onThinking = onThinking;

    if (signal) {
      if (signal.aborted) return rejectSessionOnce(session, new Error('Request aborted'));
      signal.addEventListener('abort', () => rejectSessionOnce(session, new Error('Request aborted')), { once: true });
    }

    resetIdleTimer(session);
    drainExecQueue(session);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把客户端工具执行结果翻译回 Cursor 期望的 execClientMessage 结构
async function replyBridgedTool(session, kind, id, execId, rawArgs, outputText, isError) {
  const text = outputText == null ? '' : String(outputText);

  if (kind === 'write') {
    const filePath = rawArgs.path || rawArgs.filePath || rawArgs.absPath || rawArgs.relativeWorkspacePath || '';
    if (isError) {
      sendFrame(session, { execClientMessage: { id, execId, writeResult: { error: { path: filePath, error: text || 'Client failed to write file' } } } });
    } else {
      sendFrame(session, { execClientMessage: { id, execId, writeResult: { success: {} } } });
    }
    return;
  }

  if (kind === 'shell' || kind === 'shellStream') {
    const cwd = rawArgs.workingDirectory || WORKSPACE_ROOT;
    const command = rawArgs.command || '';
    if (kind === 'shellStream') {
      // 协议已从 Cursor 桌面客户端自带的 workbench.desktop.main.js 里的 protobuf 反射 schema 精确确认:
      // agent.v1.ShellStream 的 event oneof = stdout/stderr/exit/rejected/permissionDenied/start/backgrounded/hookContext
      // agent.v1.ShellStreamStdout/Stderr = { data: string }
      // agent.v1.ShellStreamExit = { code: uint32, cwd: string, outputLocation?, aborted: bool, abortReason?, localExecutionTimeMs?: int32 }
      const start = Date.now();
      sendFrame(session, { execClientMessage: { id, execId, localExecutionTimeMs: 0, shellStream: { start: {} } } });
      await sleep(80);
      if (text) sendFrame(session, { execClientMessage: { id, execId, localExecutionTimeMs: Date.now() - start, shellStream: { stdout: { data: text } } } });
      await sleep(80);
      const localExecutionTimeMs = Date.now() - start;
      // localExecutionTimeMs 同时在 ExecClientMessage 顶层 (字段39) 和 ShellStreamExit 内部 (字段6) 都有定义, 两处都填。
      sendFrame(session, { execClientMessage: { id, execId, localExecutionTimeMs, shellStream: { exit: { cwd, code: isError ? 1 : 0, aborted: false, localExecutionTimeMs } } } });
    } else {
      sendFrame(session, {
        execClientMessage: {
          id, execId,
          shellResult: {
            success: { command, workingDirectory: cwd, stdout: text, stderr: '', exitCode: isError ? 1 : 0 },
          },
        },
      });
    }
    // 跟 ENABLE_SHELL 直接执行一样, Cursor 后端目前收到这个回复后大概率也不会正常结束工具调用,
    // 所以同样挂一个兜底: 客户端 (VSCode) 已经真实执行并把结果传回来了, 没必要陪它一直卡到超时。
    const fallbackText = `命令 \`${command}\` 已由客户端 (如 VSCode) 在其本地环境执行完毕。\n\n${isError ? '执行出错' : '输出'}:\n\`\`\`\n${text || '(无输出)'}\n\`\`\``;
    armShellFallback(session, fallbackText);
    return;
  }
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

/**
 * 健康检查 (通过 GetUsableModels)
 */
async function healthCheck(token) {
  try {
    const result = await getModels(token);
    return { ok: true, models: result.models?.length || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { chat, resumeToolCall, peekPendingBridgeKind, discardPendingBridge, getModels, healthCheck, generateChecksum };
