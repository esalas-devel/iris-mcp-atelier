// End-to-end MCP protocol test: spawn the server, speak JSON-RPC over stdio.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = spawn('node', [join(here, '..', 'dist', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // not JSON — ignore
    }
  }
});

server.stderr.on('data', (chunk) => {
  process.stderr.write(`[srv] ${chunk}`);
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, 30000);
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function run() {
  // 1. initialize
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'test-client', version: '0.0.1' },
    capabilities: {},
  });
  console.log('initialize:', init.result ? 'OK' : 'FAIL');
  if (!init.result) {
    console.log('  ', JSON.stringify(init.error));
    process.exit(1);
  }
  console.log(`  server: ${init.result.serverInfo?.name} ${init.result.serverInfo?.version}`);

  notify('notifications/initialized');

  // 2. list tools
  const listed = await send('tools/list', {});
  console.log(`tools/list: ${listed.result.tools.length} tools exposed`);
  for (const t of listed.result.tools) {
    console.log(`  - ${t.name}`);
  }

  // 3. call iris_server_info
  const info = await send('tools/call', {
    name: 'iris_server_info',
    arguments: {},
  });
  const text = info.result?.content?.[0]?.text || '';
  console.log('tools/call iris_server_info:', info.result ? 'OK' : 'FAIL');
  const parsed = JSON.parse(text);
  console.log(`  IRIS version: ${parsed.version?.slice(0, 60)}...`);

  // 4. call iris_list_documents with SQL LIKE filter
  const docs = await send('tools/call', {
    name: 'iris_list_documents',
    arguments: { type: 'CLS', filter: 'User%' },
  });
  const docsText = docs.result?.content?.[0]?.text || '';
  const firstLine = docsText.split('\n')[0];
  console.log(`tools/call iris_list_documents: ${firstLine}`);

  // 5. negative test: SQL injection attempt should be rejected
  const bad = await send('tools/call', {
    name: 'iris_execute_query',
    arguments: { query: 'DROP TABLE User.ACCES' },
  });
  const badText = bad.result?.content?.[0]?.text || '';
  const rejected = bad.result?.isError === true && badText.includes('DROP');
  console.log(`tools/call iris_execute_query (DROP): ${rejected ? 'correctly rejected' : 'NOT REJECTED - SECURITY BUG'}`);
  console.log(`   server said: ${badText.slice(0, 100)}`);

  server.kill();
  process.exit(0);
}

run().catch((err) => {
  console.error('FATAL:', err);
  server.kill();
  process.exit(1);
});
