# TODO - @aiwerk/mcp-bridge (core)

## ✅ Done
- [x] Standalone MCP server mode (CLI: serve, init, install, catalog, servers, search, update)
- [x] Smart Filter Phase 1 - keyword-based filtering, default enabled
- [x] Auto-reconnect on failure (exponential backoff + jitter)
- [x] Graceful server failure isolation
- [x] 15 built-in servers (v2 recipe format)
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

## ✅ Authentication (complete as of v2.5.0)
- [x] Bearer token auth for SSE/HTTP transports
- [x] Custom header auth
- [x] OAuth2 Client Credentials - automatic token management, caching, 401 retry
- [x] OAuth2 Authorization Code + PKCE - interactive browser login, file-based token persistence, auto-refresh
- [x] CLI: `mcp-bridge auth login/logout/status`
- [x] OAuth2 Device Code flow (RFC 8628) - headless environments (VPS, Docker, CI)

## ✅ Reliability (complete as of v2.0.0)
- [x] Configurable retries - exponential backoff, per-server override, transient errors only
- [x] Graceful shutdown - SIGTERM -> wait -> SIGKILL, connection cleanup, cache clear

## ✅ Cost & Rate Limiting (complete as of v2.7.4)
- [x] Per-server rate limit - configurable daily/monthly call limits (`rateLimit: { maxCallsPerDay, maxCallsPerMonth }`)
- [x] Pre-call budget check - blocks tool call if limit exceeded, returns actionable error to agent
- [x] File persistence (~/.mcp-bridge/usage/) with daily/monthly reset
- [x] Warning threshold at 80% usage
- [x] Only count successful calls (split checkLimit/increment in v2.7.4)
- [x] Actionable error messages with suggested next limit and reset time

## ✅ Catalog Integration (complete as of v2.8.2)
- [x] `mcp-bridge install` falls back to remote catalog when not found locally (v2.8.0)
- [x] CatalogClient with offline cache fallback
- [x] Bootstrap: `bootstrapCatalog()` downloads top 15 recipes on first run
- [x] `catalog` config option (default: true) - enable/disable catalog fetch (v2.8.2)
- [x] `autoMerge` config option (default: false) - opt-in auto-merge of cached recipes (v2.8.2)
- [x] `security.requireCleanAudit` + `hostedSafe` filter
- [ ] `mcp-bridge search` queries remote catalog via MCP
- [x] Cache invalidation: staleDays (default 7), force refresh, mtime-based stale check
- [ ] Version pinning with lockfile (`~/.mcp-bridge/lock.json`)

## CLI Improvements
- [ ] `mcp-bridge servers` - show status table (connected/idle/degraded/stopped)
- [ ] `mcp-bridge usage` - show current usage stats per server
- [ ] `--log-file` option for HTTP mode
- [ ] `mcp-bridge update --catalog-only` - catalog-only update

## Spec Compliance (Universal Recipe Spec v2.0)
- [ ] `mcp-bridge migrate-recipe` CLI command (§5.2) - convert v1 config.json to v2 recipe.json
- [ ] `mcp-bridge uninstall <server>` CLI command - remove installed server
- [ ] Adapter contract formalization (§4.1) - `toNativeConfig`, `fromNativeConfig`, `install`, `uninstall` interface
- [ ] Claude Desktop adapter - recipe -> claude_desktop_config.json translation
- [ ] Cursor adapter - recipe -> .cursor/mcp.json translation
- [ ] `adapters/` override directories per recipe (§4.5) - client-specific config patches
- [x] Add imap-email to servers/index.json (v2.2.0)
- [x] Add README.md for imap-email server recipe (v2.2.0)
- [x] Remove leftover v1 config.json files (v2.3.0)
- [ ] Server icons (§2.1) - icon.svg/png per recipe directory

## Future
- [ ] Hosted bridge mode (bridge.aiwerk.ch) - multi-tenant, per-user isolation (spec: docs/hosted-bridge-spec.md, code: @aiwerk/hosted-bridge@0.2.0)
- [ ] npm publish v2.8.2 (autoMerge fix for users)
- [ ] CD pipeline - git push -> auto deploy VPS
- [ ] Transport integration tests - E2E for SSE, stdio, streamable-http
- [ ] Router edge case tests - connection drops mid-call, concurrent requests
- [ ] Local script wrapper MCP server - shell/Python scripts as typed MCP tools
- [ ] PII redaction in request/response
- [ ] OpenTelemetry / Prometheus metrics export
- [ ] Bridge-level global rate limit as fallback (all servers combined)
