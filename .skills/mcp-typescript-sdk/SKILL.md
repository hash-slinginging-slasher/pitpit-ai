---
name: mcp-typescript-sdk
description: Build MCP servers and clients with the official TypeScript SDK (@modelcontextprotocol/sdk).
when: building an MCP server or client, exposing tools/resources/prompts, or wiring stdio / Streamable HTTP transports in TypeScript
---

# MCP TypeScript SDK

Build Model Context Protocol servers (expose tools, resources, prompts to an LLM app)
and clients (connect to any MCP server) with the official SDK. Verified against
`@modelcontextprotocol/sdk@1.29.0`.

## Install

```bash
npm install @modelcontextprotocol/sdk zod
```

- `zod` is a **required peer dependency** (schema validation). Zod v3.25+ or v4 both work.
- The package is **ESM only** (`"type": "module"`) and needs **Node >= 18**. Import paths end
  in `.js` and use subpaths like `@modelcontextprotocol/sdk/server/mcp.js`.
- Use `McpServer` (high-level) unless you need raw protocol control — then use the low-level
  `Server` from `@modelcontextprotocol/sdk/server/index.js`.

## Minimal server (stdio) — tool, resource, prompt

`inputSchema` / `argsSchema` take a **raw Zod shape** (a plain object of validators), NOT
`z.object(...)`.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });

// Tool: the LLM can call this to take an action.
server.registerTool(
  "add",
  {
    title: "Addition",
    description: "Add two numbers",
    inputSchema: { a: z.number(), b: z.number() }, // raw shape, not z.object()
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

// Resource: read-only data exposed at a URI.
server.registerResource(
  "config",
  "config://app",
  { title: "App Config", description: "Application configuration", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: "app configuration here" }],
  }),
);

// Prompt: a reusable message template.
server.registerPrompt(
  "review-code",
  { title: "Code Review", description: "Review code", argsSchema: { code: z.string() } },
  ({ code }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review this code:\n\n${code}` } }],
  }),
);

// Connect a transport LAST, after everything is registered.
const transport = new StdioServerTransport();
await server.connect(transport);
```

Run it with `npx tsx server.ts`. A stdio server talks over stdin/stdout, so **never
`console.log` to stdout** — it corrupts the protocol. Log to stderr (`console.error`) instead.

## Streamable HTTP server (remote — recommended over SSE)

Streamable HTTP is the recommended transport for remote servers; plain HTTP+SSE is legacy.
Mount the transport on your HTTP framework (Express shown):

```ts
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

// Stateless variant: new transport+server per request (simplest). For stateful sessions,
// keep transports keyed by the `mcp-session-id` header and set sessionIdGenerator.
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  res.on("close", () => transport.close());
  await server.connect(transport);         // `server` = an McpServer as above
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000);
```

## Minimal client (stdio)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["server.js"] });
const client = new Client({ name: "example-client", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({ name: "add", arguments: { a: 1, b: 2 } });
// Other helpers: listResources, readResource, listPrompts, getPrompt.
```

For a remote server, swap in `StreamableHTTPClientTransport` from
`@modelcontextprotocol/sdk/client/streamableHttp.js` with a `new URL("http://host/mcp")`.

## Gotchas

- Register all tools/resources/prompts **before** `server.connect(transport)`.
- Tool callbacks return `{ content: [...] }`; each content item has a `type` (`"text"`,
  `"image"`, `"resource"`, …). Return `{ isError: true, content: [...] }` for tool errors so
  the model sees the failure instead of the call throwing.
- Keep schemas as raw shapes for `inputSchema`/`argsSchema`; use full `z.object()` only where
  the API asks for a schema object.
- stdio servers: stdout is the protocol channel — log to stderr only.

## Docs & versions

- Repo: https://github.com/modelcontextprotocol/typescript-sdk
- v1 API reference: https://modelcontextprotocol.github.io/typescript-sdk/
- **v2 is in beta** and splits into separate packages (`@modelcontextprotocol/server`,
  `@modelcontextprotocol/client`) with different import paths — see
  https://modelcontextprotocol.github.io/typescript-sdk/v2/. Prefer stable `@modelcontextprotocol/sdk`
  (1.x) for production unless you specifically want v2.
