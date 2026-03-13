# TODO — @aiwerk/mcp-bridge (core)

## ✅ Done
- [x] Standalone MCP server mode (CLI: serve, init, install, catalog, servers, search, update)
- [x] Smart Filter Phase 1 — keyword-based filtering, default enabled
- [x] Auto-reconnect on failure (exponential backoff + jitter)
- [x] Graceful server failure isolation
- [x] 13 built-in servers
- [x] Router mode (single `mcp` meta-tool, ~98% token reduction)
- [x] Direct mode (individual tool registration)
- [x] 3 transports: stdio, SSE, streamable-http
- [x] CLI: init, serve, catalog, servers, search, install, update
- [x] Update checker
- [x] CHANGELOG.md

## Smart Router v2 (spec: mcp-smart-router-spec.md)
- [ ] Intent-based routing — agent omits `server=`, router resolves
- [ ] Multi-server tool resolution — pick best match from overlapping tool names
- [ ] Vector search for tool discovery — embed tool descriptions, match semantically
- [ ] Schema compression — truncate descriptions, reduce optional params (~350→60 tokens per tool)
- [ ] Tool call result caching — LRU cache with configurable TTL
- [ ] Adaptive promotion — track usage, auto-register top N tools as native
- [ ] Natural language routing — `mcp(intent="...")` without explicit server/tool
- [ ] Full schema on demand — `action=schema` returns full JSON Schema for one tool
- [ ] Batch calls — `action=batch` for multiple tool calls in one round-trip

## Security
- [ ] Trust levels for MCP server results (trusted / untrusted / sanitize per server)
- [ ] Tool deny list (toolFilter) — block specific dangerous tools per server
- [ ] Max result size limit (maxResultChars) — cap tool response size
- [ ] HTTP auth enforcement for SSE/streamable-http mode (spec: bearer token)

## Reliability
- [ ] Configurable retries — retry count + timeout per server (default: 2 retries, 30s)
- [ ] Graceful shutdown — SIGTERM: drain pending requests, close backends (spec: 5s timeout)

## Catalog Integration
- [ ] `mcp-bridge install` falls back to remote catalog when not found locally
- [ ] `mcp-bridge search` queries remote catalog via MCP
- [ ] Cache invalidation: check `updatedAt` on catalog, refresh if newer
- [ ] Version pinning with lockfile (`~/.mcp-bridge/lock.json`)

## CLI (from standalone spec)
- [ ] `mcp-bridge servers` — show status table (connected/idle/degraded/stopped)
- [ ] `--log-file` option for HTTP mode
- [ ] `mcp-bridge update --catalog-only` — catalog-only update

## Future
- [ ] Transport integration tests — E2E for SSE, stdio, streamable-http
- [ ] Router edge case tests — connection drops mid-call, concurrent requests
- [ ] Local script wrapper MCP server — shell/Python scripts as typed MCP tools
- [ ] Hosted bridge mode (bridge.aiwerk.ch) — multi-tenant, per-user isolation
