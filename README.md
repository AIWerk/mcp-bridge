# @aiwerk/mcp-bridge

Standalone MCP server that multiplexes multiple MCP servers into one interface. Works with Claude Desktop, Cursor, Windsurf, Cline, or any MCP client.

## Install

```bash
npm install -g @aiwerk/mcp-bridge
```

## Quick Start

```bash
# Initialize config directory
mcp-bridge init

# Edit your config
vi ~/.mcp-bridge/config.json

# Install a server from the catalog
mcp-bridge install todoist

# Start (stdio mode for MCP clients)
mcp-bridge
```

## Configuration

Config location: `~/.mcp-bridge/config.json`

```json
{
  "mode": "router",
  "servers": {
    "todoist": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@doist/todoist-ai"],
      "env": {
        "TODOIST_API_KEY": "${TODOIST_API_TOKEN}"
      },
      "description": "Task management"
    },
    "github": {
      "transport": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "description": "GitHub repos, issues, PRs"
    }
  },
  "toolPrefix": true,
  "connectionTimeoutMs": 5000,
  "requestTimeoutMs": 60000
}
```

Environment variables go in `~/.mcp-bridge/.env`:

```
TODOIST_API_TOKEN=your-token-here
GITHUB_TOKEN=ghp_xxxxx
```

## Modes

**Router mode** (default) — exposes a single `mcp` meta-tool. The agent calls `mcp(server="todoist", action="list")` to discover tools, then `mcp(server="todoist", tool="get_tasks", params={...})` to call them. ~99% reduction in tool registration tokens.

**Direct mode** — registers all tools from all servers individually (`todoist_get_tasks`, `github_list_repos`, etc.). Better for few servers or simpler agents.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-bridge": {
      "command": "mcp-bridge",
      "args": []
    }
  }
}
```

## CLI

```bash
mcp-bridge                        # stdio mode (default)
mcp-bridge --verbose              # info-level logs to stderr
mcp-bridge --debug                # full protocol logs to stderr
mcp-bridge --config ./config.json # custom config file

mcp-bridge init                   # create ~/.mcp-bridge/ with template
mcp-bridge install <server>       # install from catalog
mcp-bridge catalog                # list available servers
mcp-bridge servers                # list configured servers
mcp-bridge search <query>         # search catalog
mcp-bridge update --check         # check for updates
mcp-bridge update                 # install updates
```

## Library Usage

```typescript
import { McpRouter, StandaloneServer, loadConfig } from "@aiwerk/mcp-bridge";

const config = loadConfig({ configPath: "./config.json" });
const server = new StandaloneServer(config, console);
await server.startStdio();
```

## License

MIT
