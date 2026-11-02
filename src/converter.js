// ═══════════════════════════════════════════════
//  CursorIDE2API - OpenAI ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');

function messageTextContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return '';
}

/** 将文本对话历史转换为 Cursor 接受的单段 prompt。 */
function messagesToPrompt(messages = []) {
  return messages.map(msg => {
    const content = messageTextContent(msg);
    if (!content) return '';
    if (msg.role === 'system' || msg.role === 'developer') return `<system>\n${content}\n</system>`;
    if (msg.role === 'assistant') return `<assistant>\n${content}\n</assistant>`;
    return content;
  }).filter(Boolean).join('\n\n');
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
  messagesToPrompt,
  buildChatResponse, buildStreamChunk, buildRoleChunk,
  buildErrorResponse, buildModelsResponse,
};
