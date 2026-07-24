// ═══════════════════════════════════════════════
//  CursorIDE2API - OpenAI ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const config = require('./config');
const { v4: uuidv4 } = require('uuid');

/**
 * OpenAI messages → Cursor 单一 prompt
 * Cursor Agent 只接受单个 text，我们需要拼接所有消息
 *
 * (曾尝试改用 AgentRunRequest.customSystemPrompt 原生字段单独传系统提示词，
 * 实测 Cursor 后端会直接报错 "unknown option '--system-prompt'"，说明这个字段
 * 在当前后端版本不受支持，因此系统提示词仍然用 <system> 标签拼进同一段 prompt 文本。)
 */
function messagesToPrompt(messages) {
  if (!messages || messages.length === 0) return '';

  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Vision/multi-part content
      content = msg.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }

    if (!content) continue;

    if (role === 'system') {
      parts.push(`<system>\n${content}\n</system>`);
    } else if (role === 'assistant') {
      parts.push(`<assistant>\n${content}\n</assistant>`);
    } else {
      parts.push(content);
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
