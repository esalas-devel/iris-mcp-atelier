# iris-mcp-atelier

> **Heads-up:** this is a small personal demo, not a production-grade package.
> It was thrown together to show that you can let Claude Code work against a
> live InterSystems IRIS instance via the Atelier REST API, without needing
> the files to be available on your local disk. Treat the code accordingly —
> use it, fork it, break it, rewrite it.

An [MCP](https://modelcontextprotocol.io/) server that gives Claude Code (and
any other MCP-aware AI client) direct access to an InterSystems IRIS server
through the built-in **Atelier REST API**.

It works around the current VS Code limitation where Claude Code can't see
files served over `isfs://`: instead of going through the editor, Claude
talks to IRIS directly and can read, write, edit, search and compile
ObjectScript against the live server.

## Quick start (5 steps)

```bash
# 1. Clone
git clone https://github.com/<your-user>/iris-mcp-atelier.git
cd iris-mcp-atelier

# 2. Install and build
npm install
npm run build

# 3. Point it at your IRIS server
cp .env.example .env
# then edit .env with your IRIS_SERVER_URL / USERNAME / PASSWORD / NAMESPACE

# 4. Register it with Claude Code (any folder)
claude mcp add iris-atelier -s user -- node "$(pwd)/dist/index.js"

# 5. Restart Claude Code and run /mcp — you should see "iris-atelier" connected
```

That's it. From now on Claude can call tools like `iris_read_document`,
`iris_search`, `iris_compile`, etc.

If you'd rather not install it globally, drop a `.mcp.json` at the root of
the project where you want to use it:

```json
{
  "mcpServers": {
    "iris-atelier": {
      "command": "node",
      "args": ["C:/absolute/path/to/iris-mcp-atelier/dist/index.js"]
    }
  }
}
```

## What you can ask Claude once it's wired up

(With `IRIS_DEFAULT_NAMESPACE` set in `.env`, you don't need to mention the
namespace in every prompt — Claude will fall back to it. You can still say
"in the SAMPLES namespace" when you want to target a different one.)

Simple lookups:

- *"Show me `User.Person`"*
- *"Just give me the `OnBeforeSave` method of `User.Person`"*
- *"What's the superclass chain of `User.MyClass`?"*

Where things get interesting — multi-tool workflows Claude will run
autonomously:

- *"Trace what happens when a `User.Order` is saved: walk through `%OnBeforeSave`, list every method it calls, and flag anything that writes to a global."*
- *"Find every class that references the deprecated `$ZF(-1)` shell-out and give me a table of which method/line each occurrence is in."*
- *"Rename `GetName` to `FetchName` across the whole `MyApp.*` package — update the definition, every caller, and recompile. Stop and report if anything doesn't compile."*
- *"Look at `MyApp.PriceCalculator.CalculatePrice` and suggest a handful of unit-test cases for the edge conditions you can see in the code."*
- *"Generate a markdown cheatsheet for `MyApp.Utilities`: one line per ClassMethod with its signature and what it actually does."*
- *"I added a new property `Email` to `User.Person`. Find every method in the class that builds a display string and update it to include the email."*
- *"Give me a read-only audit of `MyApp.Auth.*`: list the public methods, which ones hit SQL, and whether any of them log the caller."*

## Tools exposed

| Tool | Purpose |
|------|---------|
| `iris_server_info` | Server version, API version, namespace list |
| `iris_list_namespaces` | Just the namespace list |
| `iris_list_documents` | List documents in a namespace (filter uses SQL LIKE: `User%`, `%Utils%`) |
| `iris_read_document` | Read full source of a class / routine / include / CSP page |
| `iris_write_document` | Create or overwrite a document |
| `iris_edit_document` | Find/replace inside a document without a full round-trip |
| `iris_delete_document` | Delete a document |
| `iris_compile` | Compile one or more documents and return errors |
| `iris_execute_query` | Run a **read-only** SQL query (SELECT / EXPLAIN / SHOW / WITH) |
| `iris_search` | Full-text search across documents in a namespace |
| `iris_get_class_info` | Properties, methods, parameters and indices of a class |
| `iris_get_class_hierarchy` | Superclasses and direct subclasses |
| `iris_read_method` | Extract a single method from a class |

## Requirements

- Node.js 18 or newer
- An InterSystems IRIS server with the Atelier REST API reachable
- An IRIS user that can authenticate against the Atelier API

## Safety notes

- `iris_execute_query` only accepts `SELECT` / `EXPLAIN` / `SHOW` / `DESCRIBE`
  / `WITH`. Destructive statements (`INSERT`, `UPDATE`, `DELETE`, `DROP`,
  `CREATE`, `CALL`, …) are rejected before reaching IRIS, including inside
  subqueries.
- `iris_edit_document` refuses to run if `old_string` matches more than once
  in the document (unless you pass `replace_all: true`).
- Everything else — writing, deleting, compiling — runs with whatever the
  configured IRIS account can do. Use a dedicated, narrowly-scoped account
  if that matters to you.

Again: this is a demo. Don't hand it unrestricted credentials.

## Development and verification

```bash
npm run dev     # hot-reload via tsx
npm run build   # compile TypeScript to dist/
npm start       # run the compiled server
```

Two small smoke tests are included to verify a working setup against your
IRIS server (requires `.env` to be filled in):

```bash
node test/smoke.mjs      # exercises the Atelier client directly
node test/protocol.mjs   # spawns the MCP server and speaks JSON-RPC to it
```

## Troubleshooting

- **`/mcp` doesn't show the server.** Check `claude mcp list`; make sure the
  path to `dist/index.js` is absolute and exists. After changing config,
  restart Claude Code.
- **Connection errors.** Verify `IRIS_SERVER_URL` is reachable, that the
  user can authenticate, and that nothing is blocking the port.
- **`iris_search` is slow or empty.** The fast path uses the Atelier v2
  `/action/search` endpoint, which isn't available on older IRIS builds. The
  server falls back to a per-document scan, which works but is slower.

## License

MIT — see [LICENSE](./LICENSE). Use at your own risk.
