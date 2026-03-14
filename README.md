# @aiwerk/mcp-bridge

[![Tests](https://github.com/AIWerk/mcp-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/AIWerk/mcp-bridge/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@aiwerk/mcp-bridge.svg)](https://www.npmjs.com/package/@aiwerk/mcp-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Multiplex multiple MCP servers into one interface. One config, one connection, all your tools.

Works with **Claude Desktop**, **Cursor**, **Windsurf**, **Cline**, **OpenClaw**, or any MCP client.

## Why?

Most AI agents connect to MCP servers one-by-one. With 10+ servers, that's 10+ connections, 200+ tools in context, and thousands of wasted tokens.

**MCP Bridge** solves this:
- **Router mode**: all servers behind one `mcp` meta-tool (~99% token reduction)
- **Intent routing**: say what you need in plain language, the bridge finds the right tool
- **Schema compression**: tool descriptions compressed ~57%, full schema on demand
- **Security layer**: trust levels, tool deny/allow lists, result size limits
- **Direct mode**: all tools registered individually with automatic prefixing
- **3 transports**: stdio, SSE, streamable-http
- **Built-in catalog**: 14 pre-configured servers, install with one command
- **Zero config secrets in files**: `${ENV_VAR}` resolution from `.env`

## Install

```bash
npm install -g @aiwerk/mcp-bridge
```

## Quick Start

```bash
# 1. Initialize config
mcp-bridge init

# 2. Install a server from the catalog
mcp-bridge install todoist

# 3. Add your API key
echo "TODOIST_API_TOKEN=your-token" >> ~/.mcp-bridge/.env

# 4. Start (stdio mode — connects to any MCP client)
mcp-bridge
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "mcp-bridge",
      "args": []
    }
  }
}
```

## Use with Cursor / Windsurf

Add to your MCP config:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "mcp-bridge",
      "args": ["--config", "/path/to/config.json"]
    }
  }
}
```

## Use with OpenClaw

Install as a plugin (handles everything automatically):

```bash
openclaw plugins install @aiwerk/openclaw-mcp-bridge
```

> ⚠️ **Important:** Always use the full scoped name `@aiwerk/openclaw-mcp-bridge`. The unscoped `openclaw-mcp-bridge` on npm is a **different, unrelated package**.

See [@aiwerk/openclaw-mcp-bridge](https://github.com/AIWerk/openclaw-mcp-bridge) for details.

## Configuration

Config: `~/.mcp-bridge/config.json` | Secrets: `~/.mcp-bridge/.env`

```json
{
  "mode": "router",
  "servers": {
    "todoist": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@doist/todoist-ai"],
      "env": { "TODOIST_API_KEY": "${TODOIST_API_TOKEN}" },
      "description": "Task management"
    },
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "description": "GitHub repos, issues, PRs"
    },
    "notion": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-notion"],
      "env": { "NOTION_API_KEY": "${NOTION_TOKEN}" },
      "description": "Notion pages and databases"
    }
  },
  "toolPrefix": true,
  "connectionTimeoutMs": 5000,
  "requestTimeoutMs": 60000,
  "schemaCompression": {
    "enabled": true,
    "maxDescriptionLength": 80
  }
}
```

### Schema Compression

In router mode, tool descriptions from upstream servers can be verbose (100-300+ chars each). Schema compression truncates them to save tokens:

- **Enabled by default** — descriptions capped at 80 characters
- Cuts at sentence boundary when possible, otherwise word boundary
- Use `action=schema` to retrieve the full uncompressed schema for any tool on demand

```json
"schemaCompression": {
  "enabled": true,
  "maxDescriptionLength": 80
}
```

**Token savings example:** 30 Todoist tools: ~2800 tokens uncompressed -> ~1200 compressed (~57% reduction).

To get full details for a specific tool:
```
mcp(server="todoist", action="schema", tool="find-tasks")
```

Set `"enabled": false` to disable compression and return full descriptions.

### Intent Routing

Instead of specifying the exact server and tool, describe what you need:

```
mcp(action="intent", intent="find my tasks for today")
```

The bridge uses vector embeddings to match your intent to the right server and tool automatically. Returns the best match with a confidence score and alternatives.

**Embedding providers** (configured via `intentRouting.embedding`):

| Provider | Config | Requires |
|----------|--------|----------|
| `gemini` (default for auto) | `GEMINI_API_KEY` in `.env` | Free tier available |
| `openai` | `OPENAI_API_KEY` in `.env` | Paid API |
| `ollama` | Local Ollama running | No API key |
| `keyword` | Nothing | Offline fallback, less accurate |

```json
"intentRouting": {
  "embedding": "auto",
  "minScore": 0.3
}
```

- `auto` (default): tries gemini, openai, ollama, then keyword - in order of availability
- `minScore`: minimum confidence to return a match (0-1, default: 0.3)
- Index is built lazily on first `action=intent` call

### Security

Three layers of protection for tool results:

#### Trust Levels

Per-server control over how results are passed to the agent:

```json
"servers": {
  "my-trusted-server": {
    "trust": "trusted"
  },
  "unknown-server": {
    "trust": "untrusted"
  },
  "sketchy-server": {
    "trust": "sanitize"
  }
}
```

| Level | Behavior |
|-------|----------|
| `trusted` (default) | Results pass through as-is |
| `untrusted` | Results tagged with `_trust: "untrusted"` metadata |
| `sanitize` | HTML tags stripped, prompt injection patterns removed |

#### Tool Filter

Control which tools are visible and callable per server:

```json
"servers": {
  "github": {
    "toolFilter": {
      "deny": ["delete_repository"],
      "allow": ["list_repos", "create_issue", "search_code"]
    }
  }
}
```

- `deny`: block specific dangerous tools
- `allow`: whitelist mode - only these tools are visible
- If both: allowed tools minus denied ones
- Applied in both tool listing and execution (defense in depth)

#### Max Result Size

Prevent oversized responses from consuming your context:

```json
{
  "maxResultChars": 50000,
  "servers": {
    "verbose-server": {
      "maxResultChars": 10000
    }
  }
}
```

- Global default + per-server override
- Truncated results include `_truncated: true` and `_originalLength`

### Modes

| Mode | Tools exposed | Best for |
|------|--------------|----------|
| `router` (default) | Single `mcp` meta-tool | 3+ servers, token-conscious agents |
| `direct` | All tools individually | Few servers, simple agents |

**Router mode** — the agent calls `mcp(server="todoist", action="list")` to discover, then `mcp(server="todoist", tool="find-tasks", params={...})` to execute.

**Direct mode** — tools are registered as `todoist_find_tasks`, `github_list_repos`, etc.

### Transports

| Transport | Config key | Use case |
|-----------|-----------|----------|
| `stdio` | `command`, `args` | Local CLI servers (most common) |
| `sse` | `url`, `headers` | Remote SSE servers |
| `streamable-http` | `url`, `headers` | Modern HTTP-based servers |

### Environment variables

Secrets go in `~/.mcp-bridge/.env` (chmod 600 on init):

```
TODOIST_API_TOKEN=your-token-here
GITHUB_TOKEN=ghp_xxxxx
NOTION_TOKEN=ntn_xxxxx
```

Use `${VAR_NAME}` in config — resolved from `.env` + system env.

## CLI Reference

```bash
mcp-bridge                        # Start in stdio mode (default)
mcp-bridge --sse --port 3000      # Start as SSE server
mcp-bridge --http --port 3000     # Start as HTTP server
mcp-bridge --verbose              # Info-level logs to stderr
mcp-bridge --debug                # Full protocol logs to stderr
mcp-bridge --config ./my.json     # Custom config file

mcp-bridge init                   # Create ~/.mcp-bridge/ with template
mcp-bridge install <server>       # Install from catalog
mcp-bridge catalog                # List available servers
mcp-bridge servers                # List configured servers
mcp-bridge search <query>         # Search catalog by keyword
mcp-bridge update [--check]       # Check for / install updates
mcp-bridge --version              # Print version
```

## Server Catalog

Built-in catalog with pre-configured servers:

| Server | Transport | Description |
|--------|-----------|-------------|
| todoist | stdio | Task management |
| github | stdio | Repos, issues, PRs |
| notion | stdio | Pages and databases |
| stripe | stdio | Payments and billing |
| linear | stdio | Project management |
| google-maps | stdio | Places, geocoding, directions |
| hetzner | stdio | Cloud infrastructure |
| miro | stdio | Collaborative whiteboard |
| wise | stdio | International payments |
| tavily | stdio | AI-optimized web search |
| apify | streamable-http | Web scraping and automation |
| atlassian | stdio | Confluence and Jira |
| chrome-devtools | stdio | Chrome browser automation |
| hostinger | sse | Web hosting management |

```bash
mcp-bridge install todoist    # Interactive setup with API key prompt
mcp-bridge catalog            # Full list
mcp-bridge search payments    # Search by keyword
```

## Library Usage

Use as a dependency in your own MCP server or OpenClaw plugin:

```typescript
import { McpRouter, StandaloneServer, loadConfig } from "@aiwerk/mcp-bridge";

// Quick start
const config = loadConfig({ configPath: "./config.json" });
const server = new StandaloneServer(config, console);
await server.startStdio();
```

```typescript
// Use the router directly
import { McpRouter } from "@aiwerk/mcp-bridge";

const router = new McpRouter(servers, config, logger);
const result = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });
```

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────────────┐
│  Claude Desktop  │     │  MCP Bridge                                  │
│  Cursor          │◄───►│                                              │
│  Windsurf        │stdio│  ┌──────────┐  ┌────────┐  ┌────────────┐  │
│  OpenClaw        │ SSE │  │  Router   │  │Security│  │  Backend   │  │
│  Any MCP client  │ HTTP│  │  Intent   │─►│ Trust  │─►│  servers:  │  │
└─────────────────┘     │  │  Schema   │  │ Filter │  │  • todoist │  │
                        │  │  Compress │  │ Limit  │  │  • github  │  │
                        │  └──────────┘  └────────┘  │  • notion  │  │
                        │                            │  • stripe  │  │
                        │                            └────────────┘  │
                        └──────────────────────────────────────────────┘
```

## Related

- **[@aiwerk/openclaw-mcp-bridge](https://github.com/AIWerk/openclaw-mcp-bridge)** — OpenClaw plugin wrapper (uses this package as core)
- **[MCP Specification](https://spec.modelcontextprotocol.io)** — Model Context Protocol spec
- **[Awesome MCP Servers](https://github.com/punkpeye/awesome-mcp-servers)** — Community server directory

## License

MIT — [AIWerk](https://aiwerk.ch)
