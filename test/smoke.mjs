// Smoke test: hits each tool path via AtelierClient without going through MCP.
// Run with: node test/smoke.mjs (from the repo root)

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AtelierClient } from '../dist/atelier-client.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '.env') });

const client = new AtelierClient({
  serverUrl: process.env.IRIS_SERVER_URL,
  username: process.env.IRIS_USERNAME,
  password: process.env.IRIS_PASSWORD,
  timeout: 30000,
});

const ns = process.env.IRIS_DEFAULT_NAMESPACE || 'USER';

function header(title) {
  console.log('\n========== ' + title + ' ==========');
}

async function run() {
  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      const result = await fn();
      console.log(`  PASS: ${name}`);
      passed++;
      return result;
    } catch (err) {
      console.log(`  FAIL: ${name} — ${err.message}`);
      failed++;
      return null;
    }
  }

  header('Server info');
  const info = await check('getServerInfo', () => client.getServerInfo());
  if (info) {
    console.log(`    version: ${info.version}`);
    console.log(`    api:     ${info.api}`);
    console.log(`    namespaces (${info.namespaces.length}): ${info.namespaces.slice(0, 5).join(', ')}${info.namespaces.length > 5 ? ', …' : ''}`);
  }

  header(`List documents in ${ns}`);
  // Try a few filter formats to see which one the Atelier server accepts
  for (const f of ['User.*', 'User%', 'User*', '%User%', undefined]) {
    const docs = await check(
      `listDocuments (CLS, filter=${JSON.stringify(f)})`,
      () => client.listDocuments(ns, { type: 'CLS', filter: f }),
    );
    if (docs) console.log(`    → ${docs.length} match(es)`);
  }

  header(`Read a known document`);
  const firstDoc = 'User.ACCES.cls';
  const content = await check(`getDocumentContent(${firstDoc})`, () =>
    client.getDocumentContent(ns, firstDoc),
  );
  if (content) {
    const lines = content.split('\n');
    console.log(`    ${lines.length} lines`);
    console.log(`    first line: ${lines[0].slice(0, 80)}`);
  }

  header(`Read-only SQL query`);
  const rows = await check(
    'executeQuery (SELECT TOP 3 Name FROM %Dictionary.ClassDefinition)',
    () =>
      client.executeQuery(
        ns,
        "SELECT TOP 3 Name FROM %Dictionary.ClassDefinition WHERE Name LIKE 'User.%'",
      ),
  );
  if (rows) {
    console.log(`    ${rows.content.length} row(s):`);
    for (const r of rows.content) console.log(`      - ${r.Name}`);
  }

  header(`Search`);
  const matches = await check('search for "%Persistent"', () =>
    client.search(ns, '%Persistent', { type: 'CLS', maxResults: 5 }),
  );
  if (matches) {
    console.log(`    ${matches.length} match(es) (capped at 5)`);
    for (const m of matches.slice(0, 3)) {
      console.log(`      - ${m.doc}:${m.line}`);
    }
  }

  header(`Class introspection`);
  const className = firstDoc.replace(/\.cls$/, '');
  const classInfo = await check(`getClassInfo(${className})`, () =>
    client.getClassInfo(ns, className),
  );
  if (classInfo) {
    const propCount = (classInfo.properties || []).length;
    const methodCount = (classInfo.methods || []).length;
    const indexCount = (classInfo.indices || []).length;
    console.log(`    ${propCount} properties, ${methodCount} methods, ${indexCount} indices`);
  }

  header('Summary');
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
