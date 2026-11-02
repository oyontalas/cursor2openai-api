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

};

module.exports = config;
