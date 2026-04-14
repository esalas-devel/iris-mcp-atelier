# iris-mcp-atelier

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
**InterSystems IRIS** that talks to your server through the built-in
**Atelier REST API**.

It lets an MCP-aware AI client (Claude Code, Claude Desktop, etc.) read,
write, edit, search and compile ObjectScript **directly against a live IRIS
instance — no local files required**. This works around the current VS Code
limitation that prevents Claude Code from seeing `isfs://` virtual files.

## Why?

If you develop against IRIS using the [InterSystems ObjectScript VS Code
extension](https://marketplace.visualstudio.com/items?itemName=intersystems-community.vscode-objectscript)
with server-side editing (`isfs://`), Claude Code cannot see your code: the
files don't exist on the local disk. See [the discussion on the InterSystems
community](https://community.intersystems.com/post/claude-code-vs-isfs-has-anyone-cracked-how-get-one-see-other).

Rather than moving everything to client-side editing, this MCP server gives
Claude its own direct connection to IRIS. Claude can:

- **Read** and **write** documents (classes, routines, includes, CSP pages)
- **Edit** documents with server-side find/replace, without transferring the full contents back and forth
- **Search** across every document in a namespace
- **Compile** and get structured error output
- **Inspect classes** (properties, methods, parameters, indices, hierarchy)
- **Read a single method** from a class (cheaper than loading the whole file)
- **Run read-only SQL** against the server (SELECT / EXPLAIN / SHOW / WITH)

It stays out of your source-control workflow: files live on the server, your
existing tooling (deltanji, isc-dev, Git-based exports, …) keeps working.

## Requirements

- Node.js 18 or newer
- An InterSystems IRIS server with the Atelier REST API enabled (on by
  default in modern releases)
- An IRIS user with permission to use the Atelier API

## Installation

Clone the repo and build:

```bash
git clone https://github.com/<your-org>/iris-mcp-atelier.git
cd iris-mcp-atelier
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your IRIS connection details:

```env
IRIS_SERVER_URL=http://localhost:52773
IRIS_USERNAME=_SYSTEM
IRIS_PASSWORD=SYS
IRIS_DEFAULT_NAMESPACE=USER
IRIS_TIMEOUT=30000
```

The server loads `.env` from its own install directory, so you can point
several MCP clients at the same server without duplicating credentials.

## Hooking it up to Claude Code

### Option 1 — User-level config

Edit `~/.claude.json` (or create it):

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["/absolute/path/to/iris-mcp-atelier/dist/index.js"]
    }
  }
}
```

### Option 2 — Per-project config

Drop a `.mcp.json` at the root of the repo you want to work in:

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["/absolute/path/to/iris-mcp-atelier/dist/index.js"]
    }
  }
}
```

If you prefer not to use a `.env` file, pass the variables inline:

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["/absolute/path/to/iris-mcp-atelier/dist/index.js"],
      "env": {
        "IRIS_SERVER_URL": "http://localhost:52773",
        "IRIS_USERNAME": "_SYSTEM",
        "IRIS_PASSWORD": "SYS",
        "IRIS_DEFAULT_NAMESPACE": "USER"
      }
    }
  }
}
```

## Tools exposed

| Tool | Purpose |
|------|---------|
| `iris_server_info` | Server version, API version, namespace list |
| `iris_list_namespaces` | Just the namespace list |
| `iris_list_documents` | List documents in a namespace, filterable by type and name pattern |
| `iris_read_document` | Read full source of a class / routine / include / CSP page |
| `iris_write_document` | Create or overwrite a document with a full new body |
| `iris_edit_document` | Server-side find/replace on a single document — no full round-trip |
| `iris_delete_document` | Delete a document |
| `iris_compile` | Compile one or more documents and return errors |
| `iris_execute_query` | Run a **read-only** SQL query (SELECT / EXPLAIN / SHOW / WITH) |
| `iris_search` | Full-text search across documents in a namespace |
| `iris_get_class_info` | Properties, methods, parameters and indices of a class |
| `iris_get_class_hierarchy` | Superclasses and direct subclasses |
| `iris_read_method` | Extract a single method from a class |

### Example prompts

Once the server is wired up you can ask Claude things like:

- *"Show me `User.Person` from the USER namespace"*
- *"Find every class that extends `%Persistent` and has a method named `Save`"*
- *"Rename the method `GetName` to `FetchName` in `User.Person`"*
- *"Compile `User.Utils.cls` and show me any errors"*
- *"Search the SAMPLES namespace for uses of `$SYSTEM.OBJ.Compile`"*
- *"What's the superclass chain of `User.MyClass`?"*
- *"Just show me the `OnBeforeSave` method of `User.Person`"*

## Safety

- `iris_execute_query` refuses anything that isn't `SELECT`, `EXPLAIN`,
  `SHOW`, `DESCRIBE` or a CTE (`WITH`). Statements like `INSERT`, `UPDATE`,
  `DELETE`, `DROP`, `CREATE`, `GRANT`, `CALL`, etc. are rejected before the
  query hits IRIS, including when they appear inside subqueries.
- `iris_edit_document` refuses to run if `old_string` appears more than once
  in the document (unless you opt in with `replace_all: true`), so edits are
  always unambiguous.
- The Atelier account you configure is the ultimate trust boundary —
  everything else (write, delete, compile) is allowed and will run with that
  account's permissions. Use a dedicated user if that matters to you.

## Development

```bash
npm run dev     # hot-reload via tsx
npm run build   # compile TypeScript to dist/
npm start       # run the compiled server
```

The server communicates over `stdio`, so running it by hand just hangs
waiting for JSON-RPC input — that's expected. It's meant to be launched by an
MCP client.

## Troubleshooting

**Connection errors.** Check that IRIS is reachable at `IRIS_SERVER_URL`,
that the user can authenticate, and that the firewall allows the port.

**`iris_compile` does nothing useful.** Some Atelier builds return
compilation results in slightly different shapes. If you hit this, run the
compile via SQL instead by calling the relevant `%SYSTEM.OBJ` method from
your own tooling. (A future version may expose this as a separate tool.)

**Search returns nothing.** The Atelier v2 `/action/search` endpoint is only
available on recent IRIS releases. The server falls back to a slower
document-by-document scan when it's missing.

## Related

- [`intersystems-objectscript-routine-mcp`](https://github.com/cjy513203427/intersystems-objectscript-mcp)
  by Jinyao — a complementary MCP server focused on giving the model
  accurate **compiled routine** and **expanded macro** context, to stop it
  hallucinating APIs that don't exist. The two servers play well together:
  use Jinyao's to ground the model, this one to let it actually edit.

## License

MIT — see [LICENSE](./LICENSE).
