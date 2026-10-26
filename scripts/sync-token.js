#!/usr/bin/env node
/**
 * 从本机 Cursor 客户端的本地数据库里提取账号凭证，自动写入/更新 token.json。
 *
 * 换设备、换账号时不用再手动打开 SQLite 工具翻字段，直接跑这个脚本即可。
 *
 * 用法：
 *   node scripts/sync-token.js                   # 提取当前登录账号, 更新/新增到 token.json
 *   npm run sync-token                            # 等价于上面 (见 package.json)
 *   node scripts/sync-token.js --add              # 强制新增一条记录 (用于多账号轮询, 而不是覆盖已有的)
 *   node scripts/sync-token.js --name my-account   # 指定这条记录的 name 字段
 *   node scripts/sync-token.js --db /path/to/state.vscdb   # 手动指定数据库路径 (比如从别的设备拷过来的库文件)
 *   node scripts/sync-token.js --file ./other.json # 写入别的 token 文件 (默认项目根目录下的 token.json)
 *   node scripts/sync-token.js --dry-run           # 只打印提取结果和将要写入的内容, 不实际写文件
 *
 * 原理：Cursor 客户端把登录凭证存在本地 SQLite (state.vscdb) 的 ItemTable 表里:
 *   - cursorAuth/accessToken   认证令牌 (必须)
 *   - cursorAuth/cachedEmail   账号邮箱 (仅用于日志展示 / 自动命名)
 *   - storage.serviceMachineId  机器 ID (新版 Cursor), 没有则回退到:
 *   - telemetry.machineId / telemetry.macMachineId (老版 Cursor)
 *
 * 读取方式优先用 Node 内置的 node:sqlite (Node >= 22.5), 不可用时自动回退到系统的
 * sqlite3 命令行工具 (macOS/Linux 基本都自带, Windows 可能需要自行安装)。
 * 全程以只读/immutable 模式打开数据库, 不会影响正在运行的 Cursor 客户端。
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const DB_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/cachedEmail',
  'storage.serviceMachineId',
  'telemetry.machineId',
  'telemetry.macMachineId',
];

function defaultDbPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default: // linux 及其他类 Unix
      return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

function parseArgs(argv) {
  const args = { add: false, dryRun: false, name: null, db: null, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--add') args.add = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  const body = match ? match[1] : '';
  console.log(body.replace(/^\s*\*\s?/gm, '').trim());
}

/** 优先用内置 node:sqlite 只读打开 (Node < 22.5 或被禁用时不存在这个模块); 不可用时回退到系统 sqlite3 命令行工具。*/
function readKeys(dbPath, keys) {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch {
    // 当前 Node 版本没有内置 node:sqlite (或被 --no-experimental-sqlite 关掉), 回退到命令行工具
    return readKeysViaCli(dbPath, keys);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true, open: true });
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    const out = {};
    for (const k of keys) {
      const row = stmt.get(k);
      out[k] = row ? row.value : null;
    }
    return out;
  } finally {
    db.close();
  }
}

function readKeysViaCli(dbPath, keys) {
  const out = {};
  for (const k of keys) {
    try {
      const sql = `SELECT value FROM ItemTable WHERE key = '${k.replace(/'/g, "''")}';`;
      const value = execFileSync('sqlite3', [`file:${dbPath}?immutable=1`, sql], { encoding: 'utf8' }).trim();
      out[k] = value || null;
    } catch {
      out[k] = null;
    }
  }
  return out;
}

function decodeJwtPayload(token) {
  try {
    const payloadB64 = token.split('.')[1];
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const dbPath = args.db || defaultDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ 找不到 Cursor 的本地数据库: ${dbPath}`);
    console.error('   路径不对的话, 用 --db <path> 手动指定。');
    process.exit(1);
  }

  const row = readKeys(dbPath, DB_KEYS);

  const accessToken = row['cursorAuth/accessToken'];
  if (!accessToken) {
    console.error('❌ 数据库里没有找到 cursorAuth/accessToken, 确认这个 Cursor 客户端已经登录过账号。');
    process.exit(1);
  }

  const machineId = row['storage.serviceMachineId'] || row['telemetry.machineId'] || '';
  const macMachineId = row['telemetry.macMachineId'] || '';
  const email = (row['cursorAuth/cachedEmail'] || '').trim();

  const payload = decodeJwtPayload(accessToken);
  const expMs = payload && payload.exp ? payload.exp * 1000 : 0;
  const expired = expMs && expMs < Date.now();

  console.log(`🔑 账号: ${email || (payload && payload.sub) || '(未知)'}`);
  console.log(`   machineId: ${machineId || '(未取到, accessToken 仍可用)'}`);
  if (expMs) console.log(`   token 过期时间: ${new Date(expMs).toISOString()}${expired ? '  ⚠️ 已过期!' : ''}`);

  const tokenFilePath = path.resolve(args.file || path.join(__dirname, '..', 'token.json'));
  let store = { tokens: [] };
  if (fs.existsSync(tokenFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
      if (Array.isArray(parsed.tokens)) store = parsed;
    } catch {
      console.error(`⚠️  ${tokenFilePath} 现有内容不是合法 JSON, 将被覆盖重建。`);
    }
  }

  const newEntry = {
    name: args.name || email || `account-${store.tokens.length + 1}`,
    accessToken,
    machineId,
    macMachineId,
  };

  let matchIdx = -1;
  if (!args.add) {
    matchIdx = store.tokens.findIndex((t) => t.name === newEntry.name);
    // 只有一条记录时, 换账号也当作"更新这条", 不强制要求 name 对得上
    if (matchIdx === -1 && store.tokens.length === 1) matchIdx = 0;
  }

  if (matchIdx >= 0) {
    console.log(`✏️  更新 token.json 第 ${matchIdx + 1} 条记录 (name="${store.tokens[matchIdx].name}")`);
    store.tokens[matchIdx] = { ...store.tokens[matchIdx], ...newEntry };
  } else {
    console.log(`➕ 新增一条记录到 token.json (name="${newEntry.name}")`);
    store.tokens.push(newEntry);
  }

  if (args.dryRun) {
    console.log('\n--dry-run, 未写入文件。将写入的内容:');
    console.log(JSON.stringify(store, null, 2));
    return;
  }

  if (fs.existsSync(tokenFilePath)) {
    fs.copyFileSync(tokenFilePath, `${tokenFilePath}.bak`);
  }
  fs.writeFileSync(tokenFilePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  console.log(`\n✅ 已写入 ${tokenFilePath} (旧内容备份为 ${path.basename(tokenFilePath)}.bak)`);
  console.log('   服务如果正在运行会自动检测文件变化并热加载, 不需要重启。');
}

main();
