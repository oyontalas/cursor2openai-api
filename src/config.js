// ═══════════════════════════════════════════════
//  CursorIDE2API v2 - 简化配置
// ═══════════════════════════════════════════════

const config = {
  cursor: {
    baseUrl: 'https://api2.cursor.sh',
    clientVersion: process.env.CURSOR_CLIENT_VERSION || '3.12.17',
    defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet',
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '120000'),
    heartbeatInterval: 5000,
  },

  // 模型映射 (OpenAI model → Cursor model)
  // 右侧目标值需要是当前账号 GetUsableModels 返回的真实可用 modelId，
  // 否则请求会报 "Model name is not valid"。已对照 2026-07 的可用模型列表核实过。
  // /v1/models 接口会原样透出账号当前的真实模型清单，可用它核对目标 ID 是否仍然有效。
  modelMapping: {
    'gpt-4': 'composer-2.5',
    'gpt-4o': 'composer-2.5',
    'gpt-4o-mini': 'composer-2.5-fast',
    'gpt-4-turbo': 'composer-2.5',
    'gpt-3.5-turbo': 'composer-2.5-fast',
    'claude-3-opus': 'claude-4.6-opus-high',
    'claude-3-sonnet': 'claude-4.6-sonnet-medium',
    'claude-3.5-sonnet': 'claude-4.5-sonnet',
    'gemini-pro': 'gemini-3.1-pro',
    // 旧模型别名兼容
    'composer-2': 'composer-2.5',
    'composer-2-fast': 'composer-2.5-fast',
    'composer-1.5': 'composer-2.5-fast',
  },
};

module.exports = config;
