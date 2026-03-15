# TODO - @aiwerk/mcp-bridge (core)

## ✅ Done
- [x] Standalone MCP server mode (CLI: serve, init, install, catalog, servers, search, update)
- [x] Smart Filter Phase 1 - keyword-based filtering, default enabled
- [x] Auto-reconnect on failure (exponential backoff + jitter)
- [x] Graceful server failure isolation
- [x] 14 built-in servers (v2 recipe format)
- [x] Router mode (single `mcp` meta-tool, ~98% token reduction)
- [x] Direct mode (individual tool registration)
- [x] 3 transports: stdio, SSE, streamable-http
- [x] CLI: init, serve, catalog, servers, search, install, update
- [x] Update checker
- [x] CHANGELOG.md

## ✅ Smart Router v2 (complete as of v2.1.0)
- [x] Intent-based routing - agent omits `server=`, router resolves
- [x] Multi-server tool resolution - scoring: config priority + recency + param match
- [x] Vector search for tool discovery - embed tool descriptions, match semantically
- [x] Schema compression - truncate descriptions, reduce optional params (~350->60 tokens per tool)
- [x] Tool call result caching - LRU cache with configurable TTL, per-tool override
- [x] Adaptive promotion - track usage, auto-register top N tools as native
- [x] Natural language routing - `mcp(intent="...")` without explicit server/tool
- [x] Full schema on demand - `action=schema` returns full JSON Schema for one tool
- [x] Batch calls - `action=batch` for multiple tool calls in one round-trip

## ✅ Security (complete as of v2.0.0)
- [x] Trust levels for MCP server results (trusted / untrusted / sanitize per server)
- [x] Tool deny list (toolFilter) - block specific dangerous tools per server
- [x] Max result size limit (maxResultChars) - cap tool response size
- [x] HTTP auth - bearer token + custom headers for SSE/streamable-http

## ✅ Authentication (complete as of v2.1.0)
- [x] Bearer token auth for SSE/HTTP transports
- [x] Custom header auth
- [x] OAuth2 Client Credentials - automatic token management, caching, 401 retry

## ✅ Reliability (complete as of v2.0.0)
- [x] Configurable retries - exponential backoff, per-server override, transient errors only
- [x] Graceful shutdown - SIGTERM -> wait -> SIGKILL, connection cleanup, cache clear

## Catalog Integration
- [ ] `mcp-bridge install` falls back to remote catalog when not found locally
- [ ] `mcp-bridge search` queries remote catalog via MCP
- [ ] Cache invalidation: check `updatedAt` on catalog, refresh if newer
- [ ] Version pinning with lockfile (`~/.mcp-bridge/lock.json`)

## CLI Improvements
- [ ] `mcp-bridge servers` - show status table (connected/idle/degraded/stopped)
- [ ] `--log-file` option for HTTP mode
- [ ] `mcp-bridge update --catalog-only` - catalog-only update

## Future
- [ ] Hosted bridge mode (bridge.aiwerk.ch) - multi-tenant, per-user isolation (spec: docs/hosted-bridge-spec.md)
- [ ] Transport integration tests - E2E for SSE, stdio, streamable-http
- [ ] Router edge case tests - connection drops mid-call, concurrent requests
- [ ] Local script wrapper MCP server - shell/Python scripts as typed MCP tools
- [ ] PII redaction in request/response
- [ ] OpenTelemetry / Prometheus metrics export
