# Changelog

## [2.8.11] - 2026-03-30

### Fixed
- Init handles "already exists" from claude mcp add gracefully (shows success instead of error)

## [2.8.10] - 2026-03-30

### Fixed
- Init output shows exact file paths where registration was written

## [2.8.9] - 2026-03-30

### Features
- **Postinstall auto-init**: `npm install -g` automatically runs `mcp-bridge init`, creating config and registering with detected MCP clients (Claude Code, Cursor, Windsurf). Zero manual steps.

## [2.8.8] - 2026-03-30

### Features
- **Init auto-registration**: `mcp-bridge init` detects installed clients (Claude Code, Cursor, Windsurf) and registers automatically
- **Serve auto-init**: `mcp-bridge serve` creates config directory if missing instead of crashing

## [2.8.7] - 2026-03-30

### Fixed
- **Init onboarding**: Per-client setup commands (Claude Code: `claude mcp add`, Cursor/Desktop: JSON, OpenClaw: plugin install)
- **Global install detection**: Fixed detection for nvm-based global installs

## [2.8.6] - 2026-03-30

### Features
- **Router search/catalog/install actions**: Agents can now search, browse, and install MCP servers from the catalog directly through the mcp tool at runtime

## [2.8.5] - 2026-03-30

### Features
- **Init onboarding**: `mcp-bridge init` prints copy-pasteable client config snippet for any MCP client
- **Empty server guide**: When no servers configured, tool description guides agents to search/install from catalog

## [2.8.4] - 2026-03-30

### Features
- **Debug mode**: `debug: true` config option adds `_debug` metadata to tool call responses (server, tool, transport, latencyMs, cached flag)
- **Skill spec (§11)**: Recipe skills with gotchas, workflows, bestPractices, apiVersion - bridge-injected MCP prompts
- **Install refactor**: `mcp-bridge install` writes config directly via CatalogClient, no bash script dependency
- **Tool description**: search/install/catalog actions visible in tool description for agent discoverability
- **Empty server guide**: When no servers configured, tool description guides agents to search/install from catalog

### Fixed
- Debug type safety improvements, spec §7/§11 clarifications

## [Unreleased]

### Features
- **Debug mode** — `config.debug: true` or `--debug` CLI flag adds `_debug` metadata to tool call responses (server, tool, transport, latencyMs, cached)

### Spec
- **§11 Skills — Bridge-Injected MCP Prompts** — recipe.json `skill` field for gotchas, workflows, bestPractices; bridge generates MCP prompts when server provides none
- **§7.2 Validator** — malformed skill entries emit warnings
- **§11.4 Schema** — stale tool name references are informational (warning, not error)

## [2.8.3] - 2026-03-28

### Fixed
- **Stdio banner text** — servers printing non-JSON banner text to stdout on startup (e.g. "Server v2.1.4 running on stdio") no longer cause connection failure. The transport now accepts any stdout activity as readiness and lets `initializeProtocol()` validate the connection.

## [2.8.2] - 2026-03-26

### Features
- **`catalog` config option** (default: `true`) — controls whether recipes are fetched from catalog.aiwerk.ch
- **`autoMerge` config option** (default: `false`) — controls whether cached catalog recipes are auto-merged into config.servers (GitHub #4)
- **security.requireCleanAudit** config option — when true, blocks servers with `depAudit: "has-advisories"` (default: false)
- **CatalogClient hostedSafe** — passes `hostedSafe=true` query param when requireCleanAudit is enabled
- **Verification schema warnings** in validate-recipe.ts: tier1, tier2, depAudit field validation

### Changed
- **Breaking:** `autoMerge` now defaults to `false` (was implicitly `true` in v2.8.0). Users who want auto-discovery must explicitly set `autoMerge: true`

### Fixed
- `officialScopes` expanded with 18 new scopes (brave, hubspot, twilio-alpha, etc.)
- `@anthropic-ai` removed from communityScopes (contradiction fix)
- `KNOWN_CATEGORIES` expanded: +database, +crm

## [2.8.1] - 2026-03-25

### Features
- **§2.9 Verification spec** — new spec section for Tier Testing (tier1/tier2 verification block in recipes)
- **§2.9.3 Dependency Audit spec** — `depAudit` field for npm audit + pip-audit results
- **Origin cross-check in validator** — warns if `origin: "official"` doesn't match npm scope/author; detects community scopes (@modelcontextprotocol)
- **Known scope→author mappings** — handles cases like @playwright → Microsoft

## [2.8.0] - 2026-03-24

### Features
- **Catalog-first recipe resolution**: install-server.sh now fetches recipes from catalog.aiwerk.ch before falling back to bundled servers/
- **Bootstrap & auto-merge**: bootstrapCatalog() downloads top 15 recipes on first run; mergeRecipesIntoConfig() auto-discovers cached recipes
- **CatalogClient**: New REST client for catalog API with offline cache fallback

### Deprecations
- **Bundled servers/ directory**: Will be removed in v3.0.0. Use catalog.aiwerk.ch instead. Run `bootstrapCatalog()` to populate local cache.

## [2.7.6] - 2026-03-22

### Fixed
- **Protocol version updated to `2025-06-18`** — MCP servers implementing newer spec versions (2025+) rejected the old `2024-11-05` protocol version with HTTP 400. Updated `initializeProtocol()` and standalone server to current MCP spec. (reported by @homkai, #1)

## [2.7.5] - 2026-03-21

### Fixed
- **Token store: `list()` double-encode bug** — file names are now `decodeURIComponent()`-ed before passing to `load()`, fixing token lookup for servers with special characters. (Axel re-review finding)

## [2.7.4] - 2026-03-21

### Fixed
- **Rate limiter: only count successful calls** — split `checkAndIncrement()` into `checkLimit()` + `increment()`. Failed/errored tool calls no longer consume rate limit quota. (Axel review finding #2)
- **SSE transport: clean up `endpointUrl` on disconnect** — prevents stale endpoint URL from being used briefly during reconnect. (Axel finding #3)
- **Token store: server name collision** — `replace()` → `encodeURIComponent()` so `my.server` and `my/server` get distinct token files. (Axel finding #4)
- **AdaptivePromotion: `Math.max(...spread)` stack overflow** — replaced with `reduce()` to handle large `callTimestamps` arrays safely. (Axel finding #6)

## [2.7.3] - 2026-03-21

### Added
- **OAuth2 Auth Code in install flow**: `install-server.sh` auto-detects OAuth2 Authorization Code servers and triggers browser login (or Device Code flow on headless environments) during install.
- **prepublishOnly CHANGELOG guard**: npm publish now fails if CHANGELOG.md is missing an entry for the current version.

## [2.7.2] - 2026-03-21

### Fixed
- **Stdio deadlock fix**: MCP servers that wait for the client's `initialize` request before writing to stdout (e.g. firecrawl, fastmcp-based) caused a deadlock — bridge waited for stdout, server waited for initialize. Now the bridge proceeds optimistically after the connection timeout and lets `initializeProtocol()` validate the connection.

## [2.7.1] - 2026-03-21

### Fixed
- **npx auto-detect timeout**: Stdio transport auto-detects `command === "npx"` and uses 30s connection timeout (was 5s). First-run npx servers need time for dependency resolution.
- **firecrawl recipe**: Fixed non-existent version `3.12.1` → `3.11.0`
- **chrome-devtools recipe**: Updated `0.20.0` → `0.20.3`

## [2.7.0] - 2026-03-20

### Added
- **Cost & Rate Limiting** (`src/rate-limiter.ts`): Per-server daily/monthly call limits with actionable UX.
  - Pre-call check in router dispatch flow — blocks when limit reached
  - 80% warning threshold with concrete CLI commands in the message
  - File persistence: `~/.mcp-bridge/usage/<server>.json`
  - Auto-reset: daily at midnight UTC, monthly on 1st
  - Graceful handling of corrupt/missing usage files
  - Config: `rateLimit: { maxCallsPerDay, maxCallsPerMonth }` per server
- **CLI commands**: `mcp-bridge usage` (show usage table), `mcp-bridge limit <server> --daily N --monthly N`
- **Spec §10**: Cost & Rate Limiting section in Universal Recipe Spec
- **Spec §9.4**: Tool Manifest Hash (toolsHash) — runtime integrity verification
- **Spec §9.4.5**: Automated signing workflow (version pinning + toolsHash + validation)
- **Firecrawl recipe** (`servers/firecrawl/recipe.json`)
- **16 recipes signed** with AIWerk Ed25519 key, 8 versions pinned from `latest` to specific semver
- 9 new rate-limiter tests (282 → 291 total)

## [2.6.8] - 2026-03-20

### Added
- **Firecrawl recipe** (`servers/firecrawl/recipe.json`): Official Firecrawl MCP server — web scraping, crawling, search, and structured data extraction. Package: `firecrawl-mcp@3.12.1`, stdio transport, API key auth.

## [2.6.7] - 2026-03-19

### Fixed
- **CRITICAL: `processResult()` data loss with `trust: "sanitize"` + truncation** (`security.ts`): reverted v2.6.5 flatten logic that incorrectly included `sanitize` mode. Sanitize does NOT wrap results in `{ _trust, result }`, so the flatten was producing `{ _truncated: true, result: undefined }`. Now only `untrusted` mode flattens (as originally designed in v2.5.2).
- **Direct mode security config warning** (`standalone-server.ts`): logs `logger.warn()` at startup when `trust`, `maxResultChars`, or `toolFilter` config is present in direct mode (where `processResult()` doesn't run).
- **`reconnectTimer` not unref'd** (`transport-base.ts`): added `.unref()` to reconnect timer so Node.js process can exit gracefully when reconnect is the only pending timer.
- **`truncateArray` performance** (`security.ts`): arrays with 1000+ elements now use progressive halving instead of binary search (avoids O(n log n) `JSON.stringify` calls).
- Added regression test: `processResult with sanitize + truncated preserves result (no data loss)`.

## [2.6.6] - 2026-03-19

### Fixed
- **Catalog/search empty results**: `cmdCatalog` and `cmdSearch` now read `catalog.recipes` (v2 index.json format uses `recipes`, not `servers`). The CLI was returning empty results for `mcp-bridge catalog` and `mcp-bridge search`.
- **Logger stack trace loss**: CLI logger now preserves `Error.stack` instead of converting to `[object Object]` via `String()`.
- **Install silent failure**: `cmdInstall` catch block now logs the error message before `process.exit(1)`.
- **Stdio startup cleanup**: clarified `onFirstData` cleanup behavior with `once()` re-registration.

## [2.6.5] - 2026-03-19

### Fixed
- **Device code OAuth2 invalidation bug**: `invalidateOAuth2Token()` now correctly skips both `authorization_code` and `device_code` token-store flows in SSE and streamable-http transports (prevents `resolveOAuth2Config` throw on device_code 401 retry).
- **Dispatch error action list**: invalid action message now includes all supported actions (`status`, `promotions` were missing).
- **Result metadata consistency**: `processResult()` now flattens truncated metadata consistently for `trust: "untrusted"` to avoid nested wrappers. *(Note: v2.6.5 also included `sanitize` in the flatten, which caused data loss — reverted in v2.6.7.)*
- **SSE/stream parsing robustness**: line splitting now handles both LF and CRLF (`/\r?\n/`) in SSE and streamable-http transports.
- **Stdio startup false-positive hardening**: startup readiness now accepts JSON/LSP headers and whitespace readiness signals, while ignoring banner text on stdout (reduces fragile "connected" states).
- **.env inline comments**: `parseEnvFile()` now strips unquoted inline comments (`KEY=value # comment`) while preserving quoted `#` characters.
- **StandaloneServer init cleanup**: replaced `config.servers || {}` with nullish-safe `config.servers ?? {}`.

### Notes
- `tsconfig.json` already had `strict: true`; no change required.

## [2.6.3] - 2026-03-18

### Changed
- **Shared `doTokenRefresh()`** (`oauth2-token-manager.ts`): extracted common refresh logic from duplicate `doAuthCodeRefresh`/`doDeviceCodeRefresh` methods into a single `doTokenRefresh(serverName, stored, refreshFn, flowName)` method. Both auth_code and device_code flows now use the same wrapper.
- **Shared `refreshStoredToken()`** (`oauth2-token-manager.ts`): extracted common refresh token exchange logic from `refreshAuthCodeToken`/`refreshDeviceCodeToken` into a single method parameterized by `clientId`, `clientSecret`, and `scopes`.

### Added
- **AbortSignal support** (`cli-auth.ts`): `performDeviceCodeLogin()` now accepts an optional `signal?: AbortSignal` parameter. Checks abort state before and after sleep, passes signal to `fetch()` calls. Allows callers (e.g. OpenClaw plugin) to cancel an abandoned login flow.
- **Regression tests**: non-JSON error response recovery (HTML 500 + broken JSON → retry), AbortSignal cancellation, pre-aborted signal, `openBrowser` `execFile` source code guard.

## [2.6.2] - 2026-03-18

### Fixed
- **Shell injection in `openBrowser()`** (`cli-auth.ts`): replaced `exec()` with `execFile()` to prevent shell injection from untrusted `verification_uri_complete` URLs returned by external authorization servers.
- **Non-JSON token poll crash** (`cli-auth.ts`): polling loop now guards against non-JSON error responses (e.g. 500 HTML pages) with content-type check + try/catch on `.json()` parse.
- **`authCodeInflight` → `tokenRefreshInflight`** (`oauth2-token-manager.ts`): renamed shared inflight dedup Map for clarity (used by both auth_code and device_code flows).
- **Confidential client support** (`cli-auth.ts`, `oauth2-token-manager.ts`): added optional `clientSecret` to `DeviceCodeConfig` and `DeviceCodeOAuth2Config`, sent in device authorization and token requests per RFC 8628 §3.4.

## [2.6.1] - 2026-03-18

### Fixed
- **Device code tests opening browser**: tests called `xdg-open` on `verification_uri_complete` URLs during test runs. Added `skipBrowser` option to `DeviceCodeConfig`, used in all device code tests.

## [2.6.0] - 2026-03-18

### Added
- **OAuth2 Device Code flow (RFC 8628)** for headless environments (VPS, Docker, SSH, CI) where no browser is available. User authenticates on a separate device using a short code.
  - New `performDeviceCodeLogin()` in `cli-auth.ts` — POSTs to device authorization endpoint, displays `user_code` + `verification_uri`, polls token endpoint
  - Handles `authorization_pending`, `slow_down` (+5s interval), `expired_token`, `access_denied` responses per RFC 8628
  - Opens `verification_uri_complete` in browser when available
  - New `DeviceCodeOAuth2Config` interface + `getTokenForDeviceCode()` in `oauth2-token-manager.ts` — token store, refresh, inflight dedup
  - Transport integration: `device_code` wired into `resolveAuthHeadersAsync()` (same path as `authorization_code`)
  - CLI: `mcp-bridge auth login/status` supports `device_code` servers
  - 14 new tests (277 total)

## [2.5.3] - 2026-03-18

### Fixed
- **Build pipeline**: `prepublishOnly` now runs `tsc` before recipe validation. Previous publishes (v2.5.0–v2.5.2) shipped stale `dist/` files — OAuth2 auth CLI commands, `token-store`, and `cli-auth` were in `src/` but never compiled to `dist/`. Users got the old binary without auth support.

## [2.5.2] - 2026-03-18

### Fixed
- **XSS in auth callback** (`cli-auth.ts`): `error` and `error_description` query params are now HTML-escaped via `escapeHtml()` in the callback response. Prevents XSS from malicious authorization servers.
- **Auth code refresh race condition** (`oauth2-token-manager.ts`): added `authCodeInflight` Map for inflight deduplication. Concurrent requests no longer double-refresh (which would invalidate the refresh token on the second attempt).
- **`RouterTransportRefs` type** (`mcp-router.ts`): added `serverName?: string` parameter to SSE and streamable-http constructor signatures. Custom transport injection no longer silently loses the server name.

## [2.5.1] - 2026-03-18

### Fixed
- **Streamable HTTP SSE streaming** (`transport-streamable-http.ts`): replaced `response.text()` with `getReader()` chunked streaming for SSE responses. Previously buffered the entire response before parsing.
- **`ensureConnected` race condition**: added cooldown tracking to prevent concurrent callers from bypassing reconnect cooldown.
- **`maxResultChars` JSON-aware truncation**: truncation now respects JSON structure boundaries instead of cutting mid-value.
- **Security disclaimer**: added explicit warning that `trust: "sanitize"` is NOT a security boundary (bypassable via Unicode homoglyphs, zero-width chars, base64, multi-step chains).
- **Batch throttling**: limited concurrent batch execution to max 3 parallel calls (was unbounded).
- **`callToolWithRetry` retry documentation**: added JSDoc explaining retry conditions and backoff behavior.
- **`parseEnvFile` escaped quotes**: `.env` parser now correctly handles escaped quotes within values.
- **stdio `MAX_BUFFER`**: reduced from 50MB to 10MB (prevents OOM from runaway child processes).
- **Env merge order comments**: clarified precedence in config loading (system env > .env > defaults).

## [2.5.0] - 2026-03-18

### Added
- **OAuth2 Authorization Code flow with PKCE** for interactive browser-based login. Supports MCP servers behind enterprise SSO and user-level OAuth2 (no `clientSecret` required for public clients).
  - New CLI commands: `mcp-bridge auth login <server>`, `mcp-bridge auth logout <server>`, `mcp-bridge auth status`
  - PKCE (RFC 7636, S256 method) — mandatory for all Authorization Code flows
  - Local HTTP callback server for browser redirect (configurable port, default 9876)
  - Platform-specific browser launch (xdg-open / open / start)
  - 120-second login timeout
- **File-based token persistence** at `~/.mcp-bridge/tokens/<server>.json` (chmod 600) with automatic directory creation (chmod 700)
- **Automatic token refresh** for stored Authorization Code tokens — transparent renewal via `refresh_token` grant without user interaction
- New error codes: `-32006` (`auth_expired` — token expired, refresh failed) and `-32007` (`auth_required` — no stored token for server)
- New files: `src/token-store.ts` (FileTokenStore), `src/cli-auth.ts` (PKCE login flow), `tests/oauth2-auth-code.test.ts` (21 tests)

### Changed
- `HttpAuthConfig` type extended with `authorization_code` variant (optional `clientId`/`clientSecret`, required `authorizationUrl`/`tokenUrl`)
- `OAuth2TokenManager` accepts optional `TokenStore` for file-based token persistence
- SSE and StreamableHTTP transports now receive `serverName` for auth-code token resolution
- Transport header resolution (`resolveServerHeadersAsync`) accepts optional `serverName` parameter

### Fixed
- Transport constructors and `McpRouter.createTransport` now pass `serverName` through to auth-code OAuth2 flow (previously auth-code tokens could not be resolved at runtime)

## [2.4.0] - 2026-03-16

### Added
- **Recipe Spec v2.1**: new metadata fields — `subcategory`, `origin`, `countries`, `audience`, `selfHosted`, `sideEffects` (§3.1.1–§3.6)
- **Catalog Enrichment spec** (§3.7): dynamic metadata overlay — catalog can enrich recipes with computed/AI-extracted/curated metadata without modifying recipe files
- **Taxonomy Registry** (§3.7.5): `catalog.taxonomy()` tool + offline snapshot for categories, subcategories, origins, countries
- **All 15 recipes updated** with new metadata fields (subcategory, origin, countries, audience, selfHosted, sideEffects)
- **Regenerated `servers/index.json`** with enriched metadata entries

## [2.3.0] - 2026-03-16

### Fixed
- **LSP multi-byte UTF-8 parsing** (critical): `Content-Length` is in bytes but buffer slicing used character count, causing parse errors with non-ASCII MCP responses. Now uses byte-accurate `Buffer` operations.
- **Empty env var silent fallback**: `resolveEnvVars` silently returned `""` when `process.env.VAR` was explicitly empty and fallback found nothing. Now treats empty strings as missing values and throws, preventing silent auth failures.
- **imap-email recipe**: added missing `install` block (required for stdio), completed `auth.envVars` with all referenced env vars, added to `servers/index.json`, added `README.md`.
- **Security regex state leak**: `INJECTION_PATTERNS` were module-level `RegExp` objects with `/gi` flags sharing `lastIndex` state. Now constructs fresh `RegExp` per call.
- **Stdio startup timeout**: `startProcess()` silently resolved on timeout (dead process marked "connected"). Now rejects with error and kills the unresponsive process.
- **Router connect race condition**: concurrent callers could trigger redundant connect retries after failure. Now caches connect errors with configurable cooldown (`routerConnectErrorCooldownMs`, default 10s).
- **Shared request ID counter**: `globalRequestId` was module-level mutable state shared across instances. Moved to per-instance scope in McpRouter/StandaloneServer.

### Changed
- **CI**: removed duplicate `test.yml` workflow (kept `ci.yml` as single source of truth).
- **prepublishOnly**: `validate-recipes.sh` now runs full recipe schema validation (not just URL checks). Prevents publishing invalid recipes to npm.
- **npm package**: `servers/candidates.md` excluded via `.npmignore` (internal TODO file).
- **ESLint**: disabled `no-undef` for TypeScript files (TypeScript's own checker handles this).
- **Cleanup**: removed 5 leftover v1 `config.json` files (wise, hostinger, github, chrome-devtools, atlassian).
- **package.json**: added `git+` prefix to repository URL per npm convention.

## [2.1.4] - 2026-03-16

### Fixed
- **Unified install path**: all persistent servers (git clone, npm install) go to `~/.openclaw/mcp-servers/<name>/` instead of nested inside plugin `node_modules` (fixes TypeScript path conflicts)
- **Linear**: changed from `npm install -g` to local install in `~/.openclaw/mcp-servers/linear-mcp/`

## [2.1.3] - 2026-03-16

### Fixed
- **Wise/Hetzner clone path**: moved git clone from plugin `node_modules` to `~/.openclaw/mcp-servers/` to avoid nested `node_modules` TypeScript build failures

## [2.1.2] - 2026-03-16

### Fixed
- **Recipe URLs**: corrected Wise (`kstam` → `Szotasz`) and Hetzner (`valerius21` → `dkruyt`) repository URLs
- **CI**: added `validate-recipes.sh` and `prepublishOnly` hook to prevent broken/hallucinated URLs

## [2.1.1] - 2026-03-15

### Fixed
- Minor dependency updates

## [2.1.0] - 2026-03-15

### Added
- **OAuth2 Client Credentials auth** for SSE and streamable-HTTP transports. Automatic token acquisition, caching (with 60s expiry buffer), refresh, and single-attempt 401 retry. Env var substitution in clientId/clientSecret.
- New `src/oauth2-token-manager.ts` — shared token lifecycle manager
- Async auth header resolution (`resolveAuthHeadersAsync`, `resolveServerHeadersAsync`)
- Recipe Spec §2.3 updated: transport-level `auth` field (bearer, header, oauth2)
- Recipe Spec §2.5.1 expanded: full OAuth2 runtime config schema
- Hosted Bridge Spec v1.0 added (`docs/hosted-bridge-spec.md`)
- 6 new tests (241 total)

## [2.0.0] - 2026-03-15

### Added
- **HTTP Auth** — Bearer token and custom header auth for SSE and streamable-HTTP transports. Auth headers merge with config headers (auth wins on conflict). Env var expansion in tokens.
- **Configurable Retries** — Global and per-server retry config with exponential backoff. Only retries transient errors (timeout, connection_error). Response includes `retries` count when applicable.
- **Graceful Shutdown** — `router.shutdown(timeoutMs)` sends SIGTERM to stdio processes, waits, then SIGKILL. Closes SSE/HTTP connections, clears result cache. Exposed for plugin/CLI integration.
- New shared auth header resolution in `transport-base.ts`
- 9 new tests (235 total)

### Changed
- **Smart Router v2 complete** — all planned features implemented

## [1.9.0] - 2026-03-15

### Added
- **Multi-Server Tool Resolution** — when multiple servers provide the same tool name, the router scores candidates using config priority, recency boost, and parameter matching. Auto-dispatches when one candidate clearly wins; returns disambiguation response with `suggested: true` when scores are close.
- **Tool Call Result Caching** — LRU cache for tool call results with configurable `maxEntries`, `defaultTtlMs`, and per-tool TTL overrides. Error responses are never cached. Cache cleared on `action=refresh`.
- **Batch Calls** — `action=batch` executes multiple tool calls in parallel. Per-call error isolation (one failure doesn't abort the batch). Configurable `maxBatchSize` (default: 10).
- New source files: `src/tool-resolution.ts`, `src/result-cache.ts`
- 16 new tests (226 total)

## [1.8.0] - 2026-03-15

### Added
- **Recipe Spec v2 support** — `install-server.sh` now prefers `recipe.json` (schemaVersion 2) over legacy `config.json` with full backwards compatibility
- **Recipe Validator CLI** — `npx @aiwerk/mcp-bridge validate-recipe ./recipe.json`
- 14 bundled server recipes migrated to Universal Recipe Spec v2.0 format
- README section on Recipe Spec v2 for third-party recipe authors
- 47 new validator tests (205 total)

## [1.7.2] - 2026-03-15

### Fixed
- `types.ts`: `nextRequestId()` starts at 1, never returns 0, wraps at `MAX_SAFE_INTEGER`
- `standalone-server.ts`: LSP `Content-Length` now uses `Buffer.byteLength` (was using string length - byte vs char mismatch on UTF-8)
- `standalone-server.ts`: `writeResponse` matches client framing mode (LSP or newline-delimited)
- `transport-sse.ts`: headers resolved once in `connect()` and cached (was re-resolving env vars on every request)
- `transport-sse.ts`: removed dead `currentDataBuffer` field
- `embeddings.ts`: `OpenAIEmbedding.dimensions()` model-aware (`text-embedding-3-large` = 3072)
- `security.ts`: corrected pipeline JSDoc (sanitize only runs for `trust="sanitize"`)
- `config.ts`: clarifying comment on env merge order
- `mcp-router.ts`: removed misleading `readonly` on promotion field
- `bin/mcp-bridge.ts`: removed unused `offline` parameter from `cmdCatalog`

## [1.7.1] - 2026-03-15

### Added
- `tests/standalone-server.test.ts`: 18 unit tests for StandaloneServer (router/direct mode, tools/list, tools/call, error handling, LSP framing, shutdown)
- `tests/transport-stdio.test.ts`: 5 E2E tests with real child process (connect, tool call round-trip, disconnect, crash handling, timeout)
- Total: 158 tests

## [1.7.0] - 2026-03-15

### Fixed
- **CRITICAL**: `embeddings.ts` — `KeywordEmbedding` vocabulary now builds incrementally and freezes after indexing; query vectors share the same dimensions as indexed vectors (was rebuilding vocabulary on every call, making cosine similarity meaningless)
- `bin/mcp-bridge.ts`: Windows install support — OS detection, runs PowerShell script on win32
- `scripts/install-server.sh`: shell injection fix — server name passed via `sys.argv` instead of shell interpolation
- `update-checker.ts`: `runUpdate` uses command array instead of string split; `npmViewVersion` uses `execFile` timeout option (race condition fix)
- `bin/mcp-bridge.ts`: `cmdSearch` type cast removed (`as any` -> `forEach`)

### Changed
- `smart-filter.ts`: removed `SmartFilter` class entirely — kept standalone exported functions only (-455 lines)
- `embeddings.ts`: `GeminiEmbedding` uses `batchEmbedContents` API with chunking at 100 (was sequential per-text)
- `TODO.md`: updated to reflect completed features

## [1.6.2] - 2026-03-15

### Fixed
- `transport-base.ts`: dependency injection for env fallback (`envFallback` config option) — removes hardcoded OpenClaw import from core
- `standalone-server.ts`: LSP Content-Length framing support in `startStdio()` (alongside newline-delimited JSON)
- `standalone-server.ts`: `isError: true` flag on router error results (MCP spec compliant)
- `protocol.ts`: `PACKAGE_VERSION` multi-path candidate lookup (resilient to different build output structures)

### Added
- `tests/integration.test.ts`: end-to-end stdio child process test (initialize + tools/list)

## [1.6.1] - 2026-03-15

### Fixed
- `types.ts`: `nextRequestId()` overflow protection (modulo `MAX_SAFE_INTEGER`)
- `security.ts`: `processResult()` flattens metadata when both truncated and untrusted (was double-nesting `_truncated` inside `result`)
- `transport-sse.ts`: SSE data parsing removes exactly one leading space per spec (was `trimStart()` stripping all whitespace)
- `transport-sse.ts`: SSE endpoint URL validation requires `http://` or `https://` prefix (was accepting any `http`-prefixed string)
- `smart-filter.ts`: `clearTimeout` in `finally` block prevents timer memory leak on early `Promise.race` resolution
- `smart-filter.ts`: deduplicated `tokenize()`/`synthesizeQuery()` - now static methods on `SmartFilter` class (removed standalone duplicates with divergent Unicode logic)

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
