// ═══════════════════════════════════════════════
//  CursorIDE2API - OpenAI ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const config = require('./config');
const { v4: uuidv4 } = require('uuid');

function messageTextContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return '';
}

/**
 * OpenAI messages → Cursor 单一 prompt
 * Cursor Agent 只接受单个 text，我们需要拼接所有消息。
 *
 * 本服务定位是纯中转/桥接，不对内容做长度裁剪、重复检测等额外加工——上下文长度、死循环等
 * 应由调用方 (agent/客户端) 自行控制，这里只负责忠实地把 messages 转换成 Cursor 能接受的
 * 单段文本；如果内容确实超出模型上限，交给 Cursor 后端自然报错，再原样透传给调用方即可。
 *
 * (曾尝试改用 AgentRunRequest.customSystemPrompt 原生字段单独传系统提示词，
 * 实测 Cursor 后端会直接报错 "unknown option '--system-prompt'"，说明这个字段
 * 在当前后端版本不受支持，因此系统提示词仍然用 <system> 标签拼进同一段 prompt 文本。)
 *
 * 这里也是 tool_calls 桥接续接场景 (放弃卡死的旧会话、带完整历史开一个新会话) 的关键：
 * 必须把 assistant 发起过的 tool_calls (通常没有 content, 否则会被直接跳过、彻底丢失掉这段
 * 上下文) 和 role=tool 的工具执行结果都显式渲染进这一整段 prompt 里, 新会话的模型才能看懂
 * "之前发生了什么、工具跑出了什么结果", 从而继续把任务做下去, 而不是从头懵掉。
 *
 * ⚠️ 踩过的坑: 一开始用类似 `[调用工具 xxx, 参数: ...]` 这种"看起来像调用指令"的记法拼历史,
 * 实测模型会把它误当成"应该模仿输出的格式", 直接把这段文字原样抄一遍当成自己的回复, 而不是
 * 真正触发 Cursor 原生的工具调用机制 —— 相当于教坏了它。所以这里改成纯叙事、第三人称过去式的
 * 自然语言描述 ("我此前已经执行过 xxx, 结果是 yyy, 无需重复"), 并且明确提示这只是历史记录、
 * 不是格式范例, 尽量降低被模型模仿的风险。
 */
function messagesToPrompt(messages) {
  if (!messages || messages.length === 0) return '';

  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = messageTextContent(msg);

    if (role === 'system') {
      if (content) parts.push(`<system>\n${content}\n</system>`);
    } else if (role === 'assistant') {
      const pieces = [];
      if (content) pieces.push(content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name || tc.name || 'unknown_tool';
          const args = tc.function?.arguments ?? tc.arguments ?? '{}';
          pieces.push(`（历史记录, 并非要你模仿的输出格式: 我此前已经请求执行过工具「${name}」, 调用参数是 ${args}, 具体执行结果见后面紧跟着的"工具执行结果"这段。这一步已经真实发生过了, 不需要也不应该重新调用。）`);
        }
      }
      if (pieces.length) parts.push(`<assistant>\n${pieces.join('\n')}\n</assistant>`);
    } else if (role === 'tool') {
      if (content) parts.push(`<工具执行结果>\n${content}\n</工具执行结果>`);
    } else {
      if (content) parts.push(content);
    }
  }

  return parts.join('\n\n');
}

/**
 * 映射模型名称: OpenAI → Cursor
 */
function mapModel(model) {
  if (!model) return config.cursor.defaultModel;

  // 先查映射表
  const mapped = config.modelMapping[model];
  if (mapped) return mapped;

  // 直通 (假设用户直接传了 Cursor 模型名)
  return model;
}

/**
 * 构建非流式 OpenAI 响应
 */
function buildChatResponse(text, model, inputTokens, outputTokens) {
  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: inputTokens || 0,
      completion_tokens: outputTokens || 0,
      total_tokens: (inputTokens || 0) + (outputTokens || 0),
    },
  };
}

/**
 * 构建流式 SSE chunk
 */
function buildStreamChunk(delta, model, finishReason = null) {
  const chunk = {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta ? { content: delta } : {},
      finish_reason: finishReason,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 构建流式角色 chunk (第一条)
 */
function buildRoleChunk(model) {
  const chunk = {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 构建非流式 tool_calls 响应 (Agent 请求调用客户端本地工具, 如 Copilot 的 run_in_terminal/create_file)
 * toolCalls: [{ id, name, arguments }] (arguments 是 JSON 字符串)
 */
function buildToolCallChatResponse(toolCalls, model) {
  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * 构建流式 tool_calls SSE chunk
 */
function buildToolCallStreamChunk(toolCalls, model) {
  const chunk = {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: toolCalls.map((tc, i) => ({
          index: i,
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
      finish_reason: null,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 构建流式 tool_calls 结束 chunk
 */
function buildToolCallFinishChunk(model) {
  const chunk = {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 构建错误响应
 */
function buildErrorResponse(message, type = 'server_error', code = 500) {
  return {
    error: {
      message: message,
      type: type,
      param: null,
      code: code,
    },
  };
}

/**
 * 构建模型列表响应
 */
function buildModelsResponse(cursorModels = []) {
  const models = cursorModels.map(m => ({
    id: m.modelId || m.model_id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cursor',
    permission: [],
    root: m.modelId || m.model_id,
    parent: null,
  }));

  return {
    object: 'list',
    data: models,
  };
}

module.exports = {
  messagesToPrompt, mapModel,
  buildChatResponse, buildStreamChunk, buildRoleChunk,
  buildToolCallChatResponse, buildToolCallStreamChunk, buildToolCallFinishChunk,
  buildErrorResponse, buildModelsResponse,
};
