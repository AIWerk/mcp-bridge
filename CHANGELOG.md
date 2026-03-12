# Changelog

## [1.2.0] - 2026-03-12

### Changed
- **Smart filter enabled by default** — low thresholds (0.01/0.05) ensure high recall while reducing token usage as users add more servers
- Users can opt out with `smartFilter.enabled: false`

## [1.1.8] - 2026-03-12

### Fixed
- `update-checker.ts`: replaced all `exec`/`execSync` with `execFile`/`execFileSync` (shell injection prevention)
- `standalone-server.ts`: reject `tools/list` and `tools/call` before `initialize` (MCP spec compliance)
- `standalone-server.ts`: `discoveryPromise` race condition fix — force vs non-force no longer conflicts
- `transport-base.ts`: `handleMessage` uses `JsonRpcMessage` type instead of `any`
- `standalone-server.ts`: handle `notifications/initialized` method

### Added
- `types.ts`: `JsonRpcMessage` interface for incoming JSON-RPC messages (exported)

## [1.1.7] - 2026-03-12

### Fixed
- `standalone-server.ts`: promise mutex prevents parallel `discoverDirectTools` calls (race condition)
- `transport-streamable-http.ts`: proper SSE event boundary parsing for multi-line `data:` fields
- `bin/mcp-bridge.ts`: removed unused `execSync` import

## [1.1.6] - 2026-03-12

### Fixed
- `transport-base.ts`: `id: 0` JSON-RPC responses no longer silently dropped (`hasId` explicit check)
- `transport-sse.ts`: abort old SSE stream before creating new one on reconnect (race condition prevention)
- `bin/mcp-bridge.ts`: `execFileSync` instead of `execSync` for install command (shell injection prevention)
- `protocol.ts`: `process.stderr.write` instead of `console.warn` (don't pollute stdio transport)
- `transport-base.ts`: `PendingRequest` typed `resolve`/`reject` instead of `Function`

## [1.1.5] - 2026-03-12

### Fixed
- `transport-sse.ts`: reconnect on normal stream end (was silent disconnect)
- `transport-sse.ts`: parse `data:` and `event:` without space after colon (SSE spec compliant)
- `protocol.ts`: max 100 pages guard against cursor loop in `fetchToolsList`
- `config.ts`: use `extname()` instead of `includes(".")` for directory detection in `getConfigDir`

## [1.1.4] - 2026-03-12

### Fixed
- **Critical**: `transport-sse.ts` — SSE endpoint regression fixed. `state.event` was reset before the endpoint check, causing `connect()` to always timeout. Introduced in v1.1.3.
- `bin/mcp-bridge.ts`: validate `--config` has a value argument (was crashing with `resolve(undefined)`)
- `schema-convert.ts`: enum check moved before min/max allocation (early return optimization)

## [1.1.3] - 2026-03-12

### Fixed
- **Critical**: `scripts/install-server.sh` + `install-server.ps1` — install command was broken, looking for `scripts/servers/` instead of `../servers/`
- `transport-sse.ts`: reset `state.event` after dispatch (event type leakage prevention)
- `schema-convert.ts`: separate `integer` (`Type.Integer`) from `number` (`Type.Number`)
- `schema-convert.ts`: handle `enum` on `number` and `integer` types (not just `string`)
- `transport-streamable-http.ts`: remove `catch (error: any)` anti-pattern

## [1.1.2] - 2026-03-12

### Fixed
- `transport-streamable-http.ts`: fix double `handleMessage` call — simplified SSE processing loop
- `standalone-server.ts`: disconnect old transports before force rediscovery (zombie connection prevention)
- `transport-sse.ts`: use local `dataBuffer` array to prevent race condition on reconnect
- `config.ts`: `loadConfig` uses `getConfigDir()` instead of inline `join(path, "..")`

### Added
- `index.ts`: export `McpCallRequest` type

## [1.1.1] - 2026-03-12

### Fixed
- **Critical**: `protocol.ts` — `PACKAGE_VERSION` path fixed (`join(__dirname, "..", "..")`) — was always "0.0.0"
- **Critical**: `transport-streamable-http.ts` — process all SSE data lines, not just the last one
- **Critical**: `standalone-server.ts` — `discoverDirectTools(force)` parameter, refresh tools on reconnect
- `transport-sse.ts` — unified SSE parser state object (no split state between calls)
- `smart-filter.ts` — standalone `DEFAULTS` synced to class defaults (0.01/0.05)
- `update-checker.ts` — `execFile` instead of `exec` for npm version check
- `smart-filter.ts` — fix `keywordOnlyMatches` to properly count keyword-exclusive matches
- `config.ts` — `getConfigDir` handles directory paths correctly
- `transport-base.ts` — replace `any` with `Logger` and `McpClientConfig` types
- `mcp-router.ts` — replace `any` logger types with `Logger` interface

### Added
- `types.ts`: `McpCallRequest` interface with mandatory `id`

## [1.1.0] - 2026-03-12

### Added
- **Smart Filter v2 Phase 1** — keyword-based tool filtering to reduce token usage at scale
- Query synthesis from last 1-3 user turns (deterministic, no LLM call)
- Weighted scoring: description (1.0x) + keywords (0.7x) + synonyms (0.5x)
- Configurable thresholds, top servers, hard cap
- 12 unit tests, 100% routing recall on 30 labeled queries

## [1.0.2] - 2026-03-11

### Initial standalone release
- Core extracted from `@aiwerk/openclaw-mcp-bridge` plugin
- Smart router with stdio, SSE, and Streamable HTTP transports
- Server catalog with 12 pre-configured servers
- CLI: `mcp-bridge`, `mcp-bridge install <server>`, `mcp-bridge --list`
