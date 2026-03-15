# Changelog

## [1.6.0] - 2026-03-15

### Added
- **Adaptive Promotion** — tracks tool usage, auto-promotes frequently called tools for direct access
- `src/adaptive-promotion.ts` — `AdaptivePromotion` class with in-memory usage tracking
- `action=promotions` — returns current promoted tools and usage stats
- `getPromotedTools()` — host environments use this to register promoted tools as standalone
- Config: `adaptivePromotion.enabled` (default: false), `maxPromoted`, `minCalls`, `windowMs`, `decayMs`
- 13 new tests (126 total)

## [1.5.0] - 2026-03-15

### Added
- **Security Layer** — trust levels, tool filter, max result size
- `src/security.ts` — `sanitizeResult()`, `isToolAllowed()`, `applyMaxResultSize()`, `applyTrustLevel()`, `processResult()`
- Trust levels per server: `trusted` (passthrough), `untrusted` (tagged with metadata), `sanitize` (HTML strip + prompt injection pattern removal)
- Tool filter per server: `deny`/`allow` lists, applied in `getToolList()` and `dispatch()` (defense in depth)
- Max result size: global `maxResultChars` + per-server override, truncates with `_truncated` marker
- Security pipeline order: truncate -> sanitize -> trust-tag
- 20 new tests (113 total)

## [1.4.0] - 2026-03-15

### Added
- **Intent Routing + Vector Search** — describe what you need, the bridge finds the right tool
- `src/embeddings.ts` — 4 providers: Gemini, OpenAI, Ollama, KeywordEmbedding (offline fallback)
- `src/vector-store.ts` — in-memory cosine similarity brute-force search
- `src/intent-router.ts` — indexes tool descriptions, resolves intents to server+tool
- `action=intent` — `mcp(intent="find my tasks for today")` auto-resolves to correct server+tool
- Config: `intentRouting.embedding` (auto|gemini|openai|ollama|keyword), `minScore` (default: 0.3)
- Lazy initialization: IntentRouter only created on first `action=intent`
- Zero new npm dependencies (native fetch for API calls)
- 25 new tests (87 total)

## [1.3.0] - 2026-03-15

### Added
- **Schema Compression** — tool descriptions compressed ~57% in router mode
- `src/schema-compression.ts` — `compressDescription(desc, maxLen=80)` truncates at sentence/word boundary
- `action=schema` — returns full uncompressed JSON Schema on demand
- Config: `schemaCompression.enabled` (default: true), `maxDescriptionLength` (default: 80)

## [1.2.3] - 2026-03-14

### Added
- `DEBUG_STDIO_ENV` diagnostic logging for stdio transport (Issue #3)
- When enabled, logs resolved env vars (masked) to help debug env var substitution issues

## [1.2.2] - 2026-03-13

### Fixed
- `transport-base.ts`: Fall back to `~/.openclaw/.env` when `process.env` has empty values — fixes env var substitution failing when a pre-existing empty env var shadows the `.env` file value (dotenv `override:false` behavior)

### Added
- `config.ts`: `loadOpenClawDotEnvFallback()` — loads `~/.openclaw/.env` as a secondary env source
- `config.ts`: `resetOpenClawDotEnvCache()` — cache reset for testing

## [1.2.1] - 2026-03-13

### Fixed
- `servers/tavily/config.json`: `tavily-mcp@0.3.0` → `tavily-mcp@0.2.18` (0.3.0 does not exist on npm)
- `servers/google-maps/config.json`: `@anthropic-pb/google-maps-mcp-server` → `@modelcontextprotocol/server-google-maps` (404 on npm)
- `servers/stripe/config.json`: `@anthropic-pb/stripe-mcp-server` → `@stripe/mcp` (404 on npm)

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
