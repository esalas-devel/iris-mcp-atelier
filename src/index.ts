#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AtelierClient } from './atelier-client.js';
import { IrisConfig, DocumentCategory } from './types.js';

// Load `.env` from the directory where the server lives
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: join(__dirname, '..', '.env') });

function getConfig(): IrisConfig {
  const serverUrl = process.env.IRIS_SERVER_URL;
  const username = process.env.IRIS_USERNAME;
  const password = process.env.IRIS_PASSWORD;

  if (!serverUrl || !username || !password) {
    throw new Error(
      'Missing configuration. Set IRIS_SERVER_URL, IRIS_USERNAME and IRIS_PASSWORD (in .env or the MCP server env).',
    );
  }

  return {
    serverUrl,
    username,
    password,
    defaultNamespace: process.env.IRIS_DEFAULT_NAMESPACE,
    timeout: parseInt(process.env.IRIS_TIMEOUT || '30000', 10),
  };
}

// =============================================================================
// SQL safety: reject anything that could write to the database.
// The Atelier query endpoint will happily run INSERT/UPDATE/DELETE, so we
// gate it at the MCP layer.
// =============================================================================

function validateReadOnlySQL(query: string): void {
  const normalized = query
    .toUpperCase()
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const forbidden = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'TRUNCATE',
    'ALTER',
    'CREATE',
    'GRANT',
    'REVOKE',
    'EXEC',
    'EXECUTE',
    'CALL',
    'MERGE',
    'REPLACE',
    'UPSERT',
    'BULK',
    'LOAD',
    'KILL',
    'PURGE',
    'RENAME',
    'LOCK',
    'UNLOCK',
  ];

  for (const stmt of forbidden) {
    if (normalized.startsWith(stmt)) {
      throw new Error(
        `SQL rejected: "${stmt}" is not allowed. Only read-only queries are permitted.`,
      );
    }
    const inSubquery = new RegExp(`\\(\\s*${stmt}\\b`, 'i');
    if (inSubquery.test(normalized)) {
      throw new Error(
        `SQL rejected: "${stmt}" detected inside a subquery.`,
      );
    }
  }

  const allowed = ['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'WITH'];
  if (!allowed.some((a) => normalized.startsWith(a))) {
    throw new Error(
      `SQL rejected: only SELECT / EXPLAIN / SHOW / DESCRIBE / WITH are allowed.`,
    );
  }

  // Block `SELECT ... INTO newtable` (creates a table)
  if (normalized.includes(' INTO ') && !normalized.includes('INSERT INTO')) {
    const intoTable = /\bINTO\s+(?!:)[A-Z_][A-Z0-9_]*\s*(?:\(|$|\s+FROM)/i;
    if (intoTable.test(normalized)) {
      throw new Error(
        'SQL rejected: SELECT INTO <table> is not allowed.',
      );
    }
  }
}

// =============================================================================
// Tool definitions
// =============================================================================

const TOOLS: Tool[] = [
  {
    name: 'iris_server_info',
    description: 'Return IRIS server information (version, available namespaces, supported API features).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'iris_list_namespaces',
    description: 'List all namespaces exposed by the IRIS server.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'iris_list_documents',
    description:
      'List documents (classes, routines, includes, CSP pages, …) in a namespace. Supports filtering by type and name pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description:
            'Namespace to list (e.g. "USER", "SAMPLES"). Falls back to the default namespace when omitted.',
        },
        type: {
          type: 'string',
          enum: ['CLS', 'RTN', 'INC', 'MAC', 'INT', 'CSP', 'ALL'],
          description:
            'Document type. CLS=classes, RTN/MAC=routines, INC=includes, CSP=CSP pages, ALL=every type.',
        },
        filter: {
          type: 'string',
          description: 'SQL LIKE pattern on the document name (use "%" as wildcard, NOT "*"). Examples: "User%" matches everything starting with "User"; "%Utils%" matches anything containing "Utils".',
        },
        includeGenerated: {
          type: 'boolean',
          description: 'Include auto-generated documents (default: false).',
        },
      },
      required: [],
    },
  },
  {
    name: 'iris_read_document',
    description: 'Read the full contents of a document (class, routine, include, CSP page, …).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace where the document lives.' },
        document: {
          type: 'string',
          description: 'Full document name *including extension* (e.g. "User.Person.cls", "MyRoutine.mac", "MyInclude.inc").',
        },
      },
      required: ['document'],
    },
  },
  {
    name: 'iris_write_document',
    description:
      'Create or overwrite a document. IMPORTANT: send the COMPLETE document content — this replaces what is on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Target namespace.' },
        document: { type: 'string', description: 'Full document name with extension.' },
        content: { type: 'string', description: 'Complete document body.' },
        ignoreConflict: {
          type: 'boolean',
          description: 'Overwrite even if the server timestamp has changed (default: true).',
        },
      },
      required: ['document', 'content'],
    },
  },
  {
    name: 'iris_edit_document',
    description:
      'Apply a find/replace inside a document without having to retransmit the full contents. More efficient than read + write for small edits.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace where the document lives.' },
        document: { type: 'string', description: 'Full document name with extension.' },
        old_string: {
          type: 'string',
          description: 'Exact text to search for inside the document.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence (default: false — will error if old_string appears more than once).',
        },
      },
      required: ['document', 'old_string', 'new_string'],
    },
  },
  {
    name: 'iris_delete_document',
    description: 'Delete a document from the server.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace where the document lives.' },
        document: { type: 'string', description: 'Full document name to delete.' },
      },
      required: ['document'],
    },
  },
  {
    name: 'iris_compile',
    description: 'Compile one or more documents. Returns compilation errors and console output.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to compile in.' },
        documents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Documents to compile, e.g. ["User.Person.cls", "User.Utils.cls"].',
        },
        flags: {
          type: 'string',
          description: 'Compilation flags (default: "cuk" — compile, update, keep source).',
        },
      },
      required: ['documents'],
    },
  },
  {
    name: 'iris_execute_query',
    description:
      'Run a READ-ONLY SQL query. Only SELECT / EXPLAIN / SHOW / DESCRIBE / WITH are accepted — INSERT, UPDATE, DELETE, DROP, etc. are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to run the query in.' },
        query: {
          type: 'string',
          description: 'SQL query (e.g. "SELECT TOP 10 * FROM %Dictionary.ClassDefinition").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'iris_search',
    description: 'Full-text search across documents in a namespace. Useful for tracking down where a class or method is referenced.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to search.' },
        searchText: { type: 'string', description: 'Text to search for (case insensitive).' },
        type: {
          type: 'string',
          enum: ['CLS', 'RTN', 'INC', 'MAC', 'CSP'],
          description: 'Restrict to a document type (default: all).',
        },
        includeSystem: {
          type: 'boolean',
          description: 'Include system documents (those starting with %). Default: false.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches to return (default: 100).',
        },
      },
      required: ['searchText'],
    },
  },
  {
    name: 'iris_get_class_info',
    description: 'Summarise a class: properties, methods, parameters and indices (queried from %Dictionary).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace where the class lives.' },
        className: {
          type: 'string',
          description: 'Full class name WITHOUT extension (e.g. "User.Person", not "User.Person.cls").',
        },
      },
      required: ['className'],
    },
  },
  {
    name: 'iris_get_class_hierarchy',
    description: 'Return the superclasses and direct subclasses of a class.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace where the class lives.' },
        className: { type: 'string', description: 'Full class name without extension.' },
      },
      required: ['className'],
    },
  },
  {
    name: 'iris_read_method',
    description: 'Read a single method body from a class. Cheaper than loading the whole class when you only need one method.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace where the class lives.' },
        className: {
          type: 'string',
          description: 'Full class name without extension (e.g. "User.Person").',
        },
        methodName: { type: 'string', description: 'Method name to extract.' },
      },
      required: ['className', 'methodName'],
    },
  },
];

// =============================================================================
// Server wiring
// =============================================================================

const server = new Server(
  { name: 'mcp-server-iris-atelier', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

let client: AtelierClient;
let defaultNamespace: string;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const getNamespace = (): string => {
    const ns = (args?.namespace as string) || defaultNamespace;
    if (!ns) {
      throw new Error(
        'No namespace specified and no default namespace configured (set IRIS_DEFAULT_NAMESPACE).',
      );
    }
    return ns;
  };

  try {
    switch (name) {
      case 'iris_server_info': {
        const info = await client.getServerInfo();
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      }

      case 'iris_list_namespaces': {
        const namespaces = await client.getNamespaces();
        return {
          content: [
            {
              type: 'text',
              text: `Available namespaces:\n${namespaces.map((n) => `  - ${n}`).join('\n')}`,
            },
          ],
        };
      }

      case 'iris_list_documents': {
        const docs = await client.listDocuments(getNamespace(), {
          type: (args?.type as DocumentCategory) || undefined,
          filter: args?.filter as string,
          generated: args?.includeGenerated as boolean,
        });

        if (docs.length === 0) {
          return {
            content: [{ type: 'text', text: 'No documents matched.' }],
          };
        }

        const grouped: Record<string, string[]> = {};
        for (const doc of docs) {
          const cat = doc.cat || 'OTH';
          (grouped[cat] ||= []).push(doc.name);
        }

        let output = `Found ${docs.length} document(s):\n\n`;
        for (const [cat, names] of Object.entries(grouped)) {
          output += `## ${cat} (${names.length})\n`;
          output += names.slice(0, 50).map((n) => `  - ${n}`).join('\n');
          if (names.length > 50) {
            output += `\n  ... and ${names.length - 50} more`;
          }
          output += '\n\n';
        }
        return { content: [{ type: 'text', text: output }] };
      }

      case 'iris_read_document': {
        const document = args?.document as string;
        if (!document) throw new Error('Parameter "document" is required.');
        const content = await client.getDocumentContent(getNamespace(), document);
        return {
          content: [
            {
              type: 'text',
              text: `## ${document}\n\n\`\`\`objectscript\n${content}\n\`\`\``,
            },
          ],
        };
      }

      case 'iris_write_document': {
        const document = args?.document as string;
        const content = args?.content as string;
        if (!document) throw new Error('Parameter "document" is required.');
        if (!content) throw new Error('Parameter "content" is required.');

        const ignoreConflict = (args?.ignoreConflict as boolean) ?? true;
        const result = await client.putDocument(getNamespace(), document, content, {
          ignoreConflict,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Document "${document}" saved.\nTimestamp: ${result.ts}`,
            },
          ],
        };
      }

      case 'iris_edit_document': {
        const document = args?.document as string;
        const oldString = args?.old_string as string;
        const newString = args?.new_string as string;
        const replaceAll = (args?.replace_all as boolean) ?? false;

        if (!document) throw new Error('Parameter "document" is required.');
        if (!oldString) throw new Error('Parameter "old_string" is required.');
        if (newString === undefined || newString === null) {
          throw new Error('Parameter "new_string" is required.');
        }

        const currentContent = await client.getDocumentContent(getNamespace(), document);

        if (!currentContent.includes(oldString)) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: old_string not found in "${document}".\n\nSearched for:\n\`\`\`\n${oldString.substring(0, 200)}\n\`\`\``,
              },
            ],
            isError: true,
          };
        }

        if (!replaceAll) {
          const firstIdx = currentContent.indexOf(oldString);
          const secondIdx = currentContent.indexOf(oldString, firstIdx + 1);
          if (secondIdx !== -1) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: old_string appears multiple times in "${document}". Pass replace_all=true or make the match more specific.`,
                },
              ],
              isError: true,
            };
          }
        }

        let newContent: string;
        if (replaceAll) {
          newContent = currentContent.split(oldString).join(newString);
        } else {
          // Use a function replacer so `$` sequences in newString aren't
          // interpreted as special patterns — this matters for ObjectScript
          // macros like `$$$OK`.
          newContent = currentContent.replace(oldString, () => newString);
        }

        const result = await client.putDocument(getNamespace(), document, newContent, {
          ignoreConflict: true,
        });
        const occurrences = replaceAll
          ? currentContent.split(oldString).length - 1
          : 1;

        return {
          content: [
            {
              type: 'text',
              text: `Document "${document}" edited — ${occurrences} replacement(s).\nTimestamp: ${result.ts}`,
            },
          ],
        };
      }

      case 'iris_delete_document': {
        const document = args?.document as string;
        if (!document) throw new Error('Parameter "document" is required.');
        await client.deleteDocument(getNamespace(), document);
        return {
          content: [{ type: 'text', text: `Document "${document}" deleted.` }],
        };
      }

      case 'iris_compile': {
        const rawDocuments = args?.documents;
        if (!rawDocuments || !Array.isArray(rawDocuments) || rawDocuments.length === 0) {
          throw new Error('Parameter "documents" is required (a non-empty list).');
        }
        const documents = rawDocuments.map((d) => {
          if (typeof d === 'string') return d;
          if (typeof d === 'object' && d !== null && 'name' in d) {
            return String((d as { name: string }).name);
          }
          return String(d);
        });

        const result = await client.compile(getNamespace(), documents, {
          flags: args?.flags as string,
        });

        let output = `Compiled ${documents.length} document(s):\n\n`;
        if (result.errors.length > 0) {
          output += `### Errors (${result.errors.length})\n`;
          for (const err of result.errors) {
            const location = err.location || err.code?.toString() || 'error';
            const message =
              err.message ||
              (err as unknown as Record<string, unknown>).error ||
              JSON.stringify(err);
            output += `- **${location}**: ${message}\n`;
          }
          output += '\n';
        }
        if (result.console.length > 0) {
          output += `### Console output\n\`\`\`\n${result.console.join('\n')}\n\`\`\`\n`;
        }
        if (result.errors.length === 0) {
          output += 'Compilation completed without errors.';
        }
        return { content: [{ type: 'text', text: output }] };
      }

      case 'iris_execute_query': {
        const query = args?.query as string;
        if (!query) throw new Error('Parameter "query" is required.');
        validateReadOnlySQL(query);

        const result = await client.executeQuery(getNamespace(), query);
        if (!result.content || result.content.length === 0) {
          return { content: [{ type: 'text', text: 'Query returned no rows.' }] };
        }

        const columns = Object.keys(result.content[0]);
        let table = '| ' + columns.join(' | ') + ' |\n';
        table += '| ' + columns.map(() => '---').join(' | ') + ' |\n';
        for (const row of result.content.slice(0, 100)) {
          table +=
            '| ' +
            columns.map((c) => String(row[c] ?? '')).join(' | ') +
            ' |\n';
        }
        if (result.content.length > 100) {
          table += `\n... and ${result.content.length - 100} more rows`;
        }

        return {
          content: [
            {
              type: 'text',
              text: `Results (${result.content.length} rows):\n\n${table}`,
            },
          ],
        };
      }

      case 'iris_search': {
        const searchText = args?.searchText as string;
        if (!searchText) throw new Error('Parameter "searchText" is required.');

        const typeArg = args?.type as string;
        const searchType =
          typeArg && typeArg !== 'ALL' ? (typeArg as DocumentCategory) : undefined;

        const results = await client.search(getNamespace(), searchText, {
          type: searchType,
          system: args?.includeSystem as boolean,
          maxResults: args?.maxResults as number,
        });

        if (results.length === 0) {
          return {
            content: [
              { type: 'text', text: `No matches for "${searchText}".` },
            ],
          };
        }

        let output = `${results.length} match(es) for "${searchText}":\n\n`;
        const byDoc: Record<string, typeof results> = {};
        for (const r of results) {
          (byDoc[r.doc] ||= []).push(r);
        }
        for (const [doc, matches] of Object.entries(byDoc)) {
          output += `### ${doc}\n`;
          for (const m of matches) {
            output += `  - Line ${m.line}: \`${m.text}\`\n`;
          }
          output += '\n';
        }
        return { content: [{ type: 'text', text: output }] };
      }

      case 'iris_get_class_info': {
        const className = args?.className as string;
        if (!className) throw new Error('Parameter "className" is required.');

        const info = await client.getClassInfo(getNamespace(), className);

        let output = `# Class: ${className}\n\n`;

        const classInfo = info.classInfo as Array<Record<string, unknown>>;
        if (classInfo && classInfo.length > 0) {
          const ci = classInfo[0];
          output += `## General\n`;
          output += `- **Super**: ${ci.Super || '(none)'}\n`;
          output += `- **Abstract**: ${ci.Abstract ? 'Yes' : 'No'}\n`;
          output += `- **Final**: ${ci.Final ? 'Yes' : 'No'}\n`;
          if (ci.Description) output += `- **Description**: ${ci.Description}\n`;
          output += '\n';
        }

        const properties = info.properties as Array<Record<string, unknown>>;
        if (properties && properties.length > 0) {
          output += `## Properties (${properties.length})\n`;
          for (const p of properties) {
            output += `- **${p.Name}**: ${p.Type || 'String'}`;
            if (p.Required) output += ' (required)';
            if (p.Collection) output += ` [${p.Collection}]`;
            if (p.Description) output += ` — ${p.Description}`;
            output += '\n';
          }
          output += '\n';
        }

        const methods = info.methods as Array<Record<string, unknown>>;
        if (methods && methods.length > 0) {
          output += `## Methods (${methods.length})\n`;
          for (const m of methods) {
            const prefix = m.ClassMethod ? 'ClassMethod' : 'Method';
            output += `- **${prefix} ${m.Name}**`;
            if (m.FormalSpec) output += `(${m.FormalSpec})`;
            if (m.ReturnType) output += ` As ${m.ReturnType}`;
            if (m.Description) output += ` — ${m.Description}`;
            output += '\n';
          }
          output += '\n';
        }

        const parameters = info.parameters as Array<Record<string, unknown>>;
        if (parameters && parameters.length > 0) {
          output += `## Parameters (${parameters.length})\n`;
          for (const p of parameters) {
            output += `- **${p.Name}**`;
            if (p.Default) output += ` = ${p.Default}`;
            if (p.Description) output += ` — ${p.Description}`;
            output += '\n';
          }
          output += '\n';
        }

        const indices = info.indices as Array<Record<string, unknown>>;
        if (indices && indices.length > 0) {
          output += `## Indices (${indices.length})\n`;
          for (const i of indices) {
            output += `- **${i.Name}** [${i.Properties}]`;
            if (i.Unique) output += ' UNIQUE';
            if (i.PrimaryKey) output += ' PRIMARY KEY';
            output += '\n';
          }
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'iris_get_class_hierarchy': {
        const className = args?.className as string;
        if (!className) throw new Error('Parameter "className" is required.');

        const ns = getNamespace();
        const escaped = className.replace(/'/g, "''");

        const superResult = await client.executeQuery(
          ns,
          `SELECT Super FROM %Dictionary.ClassDefinition WHERE Name = '${escaped}'`,
        );
        const subResult = await client.executeQuery(
          ns,
          `SELECT Name FROM %Dictionary.ClassDefinition WHERE Super LIKE '%${escaped}%' ORDER BY Name`,
        );

        let output = `# Hierarchy of ${className}\n\n## Superclasses\n`;
        if (superResult.content && superResult.content.length > 0) {
          const supers = String(superResult.content[0].Super || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (supers.length > 0) {
            for (const s of supers) output += `  - ${s}\n`;
          } else {
            output += '  (none)\n';
          }
        } else {
          output += '  (none)\n';
        }

        output += `\n## Subclasses\n`;
        if (subResult.content && subResult.content.length > 0) {
          for (const row of subResult.content) {
            output += `  - ${row.Name}\n`;
          }
        } else {
          output += '  (none)\n';
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'iris_read_method': {
        const className = args?.className as string;
        const methodName = args?.methodName as string;
        if (!className) throw new Error('Parameter "className" is required.');
        if (!methodName) throw new Error('Parameter "methodName" is required.');

        const document = `${className}.cls`;
        const content = await client.getDocumentContent(getNamespace(), document);

        const lines = content.split('\n');
        let methodStart = -1;
        let methodEnd = -1;
        let braceCount = 0;
        let inMethod = false;

        const methodPattern = new RegExp(
          `^(Class)?Method\\s+${methodName}\\s*\\(`,
          'i',
        );

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!inMethod && methodPattern.test(line.trim())) {
            methodStart = i;
            inMethod = true;
            braceCount = 0;
          }
          if (inMethod) {
            for (const char of line) {
              if (char === '{') braceCount++;
              if (char === '}') braceCount--;
            }
            if (braceCount === 0 && line.includes('}')) {
              methodEnd = i;
              break;
            }
          }
        }

        if (methodStart === -1) {
          return {
            content: [
              {
                type: 'text',
                text: `Method "${methodName}" not found in class "${className}".`,
              },
            ],
            isError: true,
          };
        }

        const body = lines
          .slice(methodStart, methodEnd === -1 ? undefined : methodEnd + 1)
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `## ${className}::${methodName}\n\n\`\`\`objectscript\n${body}\n\`\`\``,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// =============================================================================
// Boot
// =============================================================================

async function main() {
  const config = getConfig();
  client = new AtelierClient(config);
  defaultNamespace = config.defaultNamespace || '';

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to write to — stdout is reserved for the MCP JSON-RPC stream
  console.error(
    `[iris-mcp-atelier] connected to ${config.serverUrl}` +
      (defaultNamespace ? ` (default ns: ${defaultNamespace})` : ''),
  );
}

main().catch((err) => {
  console.error('[iris-mcp-atelier] fatal:', err);
  process.exit(1);
});
