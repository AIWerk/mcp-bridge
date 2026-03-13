# TODO — @aiwerk/mcp-bridge (core)

## ✅ Done
- [x] Standalone MCP server mode (CLI, stdio, config loader)
- [x] Smart Filter Phase 1 — keyword-based filtering, default enabled
- [x] Auto-reconnect on failure (exponential backoff + jitter)
- [x] Graceful server failure isolation
- [x] 13 built-in servers (apify, atlassian, github, google-maps, hetzner, hostinger, linear, miro, notion, stripe, tavily, todoist, wise)
- [x] CHANGELOG.md

## Smart Mode — Phase 2+
- [ ] Vector search for tool discovery — semantic search via LanceDB/Ollama
- [ ] Schema compression — truncate descriptions, reduce optional params (~350→60 tokens per tool)
- [ ] Tool call result caching — LRU cache with configurable TTL

## Security
- [ ] Trust levels for MCP server results (trusted / untrusted / sanitize per server)
- [ ] Tool deny list (toolFilter) — block specific dangerous tools per server
- [ ] Max result size limit (maxResultChars) — cap tool response size

## Reliability
- [ ] Configurable retries — retry count + timeout per server (default: 2 retries, 30s)

## Future
- [ ] Transport integration tests — E2E for SSE, stdio, streamable-http
- [ ] Router edge case tests — connection drops mid-call, concurrent requests, crash recovery
- [ ] Local script wrapper MCP server — shell/Python scripts as typed MCP tools
