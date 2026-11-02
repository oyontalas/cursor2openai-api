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
 * 将完整 messages 转为 Cursor 接受的单段文本，不裁剪历史。
 * 系统提示词使用 <system> 标签；上游不支持 customSystemPrompt 字段。
 * 工具调用和结果必须保留，以便新会话续接；调用记录采用叙述形式，
 * 避免模型把历史中的工具调用误当成需要模仿的输出格式。
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
