# Hosted Bridge Spec v1.0

> Multi-tenant hosted MCP bridge with hybrid local/remote architecture.

---

## 1. Overview

The Hosted Bridge extends `@aiwerk/mcp-bridge` into a **multi-tenant hosted service** at `bridge.aiwerk.ch`. Users get a single URL endpoint — no local installation, no npm, no config files. The bridge runs MCP servers on behalf of users, manages their credentials, and exposes the full Smart Router v2 feature set via SSE/streamable-HTTP.

### 1.1 Design Goals

1. **Zero-friction onboarding** — paste a URL into Claude/Cursor, done
2. **Hybrid mode** — local bridge connects to hosted bridge as upstream (bridge-of-bridges)
3. **Security first** — encrypted credentials, per-user isolation, TLS everywhere
4. **Extensible** — same Universal Recipe format, same catalog integration

### 1.2 Non-Goals (Phase 1)

- Custom MCP server hosting (users run their own code on our infra)
- OAuth2 provider (we consume OAuth2, we don't issue tokens for end-user auth — we use API keys)
- Web UI for server management (CLI/API first)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    bridge.aiwerk.ch (VPS)                        │
│                                                                  │
│  ┌──────────┐   ┌──────────────────────────────────────────┐    │
│  │  Caddy    │──►│  Hosted Bridge Service                   │    │
│  │  (TLS)    │   │                                          │    │
│  └──────────┘   │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │    │
│                  │  │ User A  │  │ User B  │  │ User C  │  │    │
│                  │  │ Bridge  │  │ Bridge  │  │ Bridge  │  │    │
│                  │  │Instance │  │Instance │  │Instance │  │    │
│                  │  └────┬────┘  └────┬────┘  └────┬────┘  │    │
│                  │       │            │            │        │    │
│                  │  ┌────▼────────────▼────────────▼────┐   │    │
│                  │  │        Shared MCP Servers          │   │    │
│                  │  │  (todoist, github, stripe, etc.)   │   │    │
│                  │  └───────────────────────────────────┘   │    │
│                  └──────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Secret Store │  │  Rate Limiter│  │  Audit Logger│          │
│  │  (encrypted)  │  │  (per-user)  │  │  (per-call)  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘

           ▲ SSE/HTTP                    ▲ SSE/HTTP
           │                             │
    ┌──────┴──────┐              ┌───────┴───────┐
    │ Claude      │              │ Local Bridge  │
    │ Desktop     │              │ (hybrid mode) │
    │ (direct)    │              │  ├─ local-tools│
    └─────────────┘              │  └─ upstream:  │
                                 │     hosted     │
                                 └────────────────┘
```

### 2.1 Endpoint Structure

```
https://bridge.aiwerk.ch/u/<user-id>/mcp      — streamable-HTTP (primary)
https://bridge.aiwerk.ch/u/<user-id>/sse       — SSE (legacy clients)
https://bridge.aiwerk.ch/u/<user-id>/health    — health check
```

### 2.2 User Isolation

Each user's **stdio MCP servers** run in isolated Docker containers:
- **Filesystem isolation** — a stdio server cannot read the DB, .env, or other users' data
- **Network isolation** — `--network=none` prevents access to Vault, localhost services
- **Resource limits** — `--memory=1g --cpus=1` per container
- **Separate secret namespace** — User A cannot access User B's API keys
- **Separate config** — each user has their own server list, preferences, retry config

The main bridge process remains a single Node.js app. It handles routing, auth, and API calls (remote MCP servers). Only stdio servers — which spawn real OS processes — run inside Docker containers. This is efficient because:
- Remote API servers (GitHub, Todoist, Stripe) are just HTTP calls — no isolation needed
- Docker overhead is only paid when a user actually runs a stdio server
- Scaling the bridge itself = more instances behind a load balancer, not more containers

### 2.3 Lazy Image Building & Auto-Cleanup

Docker images for stdio servers are built **on demand** and cached:

1. **First install:** When the first user installs a stdio server (e.g. context7), the bridge builds a Docker image with the npm package pre-installed (`aiwerk/mcp-<name>:<version>`). This takes ~30 seconds once.
2. **Subsequent uses:** Any user installing the same server gets the cached image — container starts in 2-3 seconds.
3. **Shared across users:** The image is server-specific, not user-specific. 100 users running context7 = 1 image, 100 containers.
4. **Auto-cleanup:** A daily cron job checks image last-used timestamps. Images not used by any user in 30 days are automatically deleted. If a user requests the server again, the image is rebuilt on demand.

**Disk efficiency:** All images share the `node:22-slim` base layer (~330MB). Each server adds only ~10-50MB on top. 20 different servers ≈ 1.1GB total, not 20×380MB.

**Build process:**
```
docker build -t aiwerk/mcp-context7:2.1.4 - <<EOF
FROM node:22-slim
RUN npm install -g @upstash/context7-mcp@2.1.4
ENTRYPOINT ["context7-mcp"]
EOF
```

**Cleanup cron (daily):**
- Track last-used timestamp per image in SQLite
- Delete images where `last_used < now - 30 days`
- `docker rmi aiwerk/mcp-<name>:<version>`

---

## 3. Authentication & Authorization

### 3.1 User Authentication

**API key auth** (Phase 1):
- User registers via `POST /api/register` (email + password)
- Receives an API key: `ab_live_xxxxxxxxxxxx`
- All MCP requests include the key: `Authorization: Bearer ab_live_xxxxxxxxxxxx`
- API key hashed (SHA-256) at rest, never stored plaintext

**OAuth2 login** (Phase 2):
- GitHub OAuth for developer-facing registration
- Google OAuth for business users

### 3.2 Secret Management

User API keys (Todoist, GitHub, Stripe, etc.) are stored **encrypted at rest**:

```
┌────────────────────────────────────┐
│  Secret Store                      │
│                                    │
│  encryption: AES-256-GCM           │
│  key derivation: per-user from     │
│    master key + user-id (HKDF)     │
│  master key: env var, NOT in DB    │
│  storage: SQLite (encrypted blob)  │
│                                    │
│  secrets are decrypted ONLY when   │
│  spawning the user's bridge        │
│  instance — never logged, never    │
│  returned via API                  │
└────────────────────────────────────┘
```

### 3.3 Permission Model

Phase 1: flat — user has access to all their configured servers.

Phase 2 (RBAC):
- **Roles:** owner, member, viewer
- **Scopes:** per-server, per-tool
- **Use case:** team shares a hosted bridge, but only the owner can add/remove servers or change API keys

---

## 4. Rate Limiting

### 4.1 Why

Hosted = shared infrastructure. Rate limiting prevents:
- One user exhausting server resources (CPU, memory, connections)
- Accidental infinite loops in agent tool calls
- Upstream API abuse (downstream providers may ban our IP)
- Cost overruns on metered APIs

### 4.2 Implementation

**Token bucket algorithm** — per-user, per-server, sliding window.

```typescript
interface RateLimitConfig {
  // Global per-user limits
  requestsPerMinute: number;    // default: 60
  requestsPerHour: number;      // default: 1000
  requestsPerDay: number;       // default: 10000
  
  // Per-server overrides (some servers are heavier)
  serverOverrides?: Record<string, {
    requestsPerMinute?: number;
    requestsPerHour?: number;
  }>;
  
  // Burst allowance (short spike OK)
  burstSize: number;            // default: 10
}
```

**Tiers:**

| Tier | RPM | RPH | RPD | Servers | Price |
|------|-----|-----|-----|---------|-------|
| Free | 30 | 300 | 3000 | 3 | 0 |
| Pro | 120 | 2000 | 20000 | unlimited | $9/mo |
| Business | 600 | 10000 | 100000 | unlimited + RBAC | $29/mo |

**Rate limit response:**
```json
{
  "error": "rate_limited",
  "message": "Rate limit exceeded (60 req/min). Retry after 12s.",
  "retryAfterMs": 12000,
  "limit": 60,
  "remaining": 0,
  "resetAt": "2026-03-15T17:30:12Z"
}
```

**Headers** (on every response):
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1773592212
```

---

## 5. Audit Logging

### 5.1 Why

- **Compliance** — who called what, when, from where
- **Debugging** — trace failed tool calls
- **Analytics** — usage patterns, popular tools, error rates
- **Security** — detect abuse, unauthorized access attempts

### 5.2 What Gets Logged

Every tool call through the hosted bridge:

```typescript
interface AuditLogEntry {
  id: string;                   // UUID
  timestamp: string;            // ISO 8601
  userId: string;               // who
  server: string;               // which MCP server
  tool: string;                 // which tool
  action: string;               // list/call/batch/intent
  
  // Request metadata (NOT the full payload — privacy!)
  paramKeys: string[];          // param field names only
  
  // Result metadata
  status: "success" | "error" | "timeout" | "rate_limited";
  latencyMs: number;
  errorType?: string;           // if failed
  
  // Context
  sourceIp: string;             // hashed for privacy
  userAgent?: string;
  cached: boolean;              // served from result cache?
  retries: number;              // retry count if any
}
```

### 5.3 What Does NOT Get Logged

- **Parameter values** — may contain sensitive data (API keys, PII)
- **Response bodies** — may contain user data
- **Full request/response** — only metadata

Exception: admin can enable **debug mode** per-user (opt-in, time-limited, full request/response logging for troubleshooting).

### 5.4 Storage

- **Hot:** SQLite WAL (last 7 days) — fast queries
- **Cold:** compressed JSONL files (rotated daily) — long-term retention
- **Retention:** Free tier 7 days, Pro 30 days, Business 90 days

### 5.5 Queryable via Admin API

```
GET /admin/audit?userId=...&server=...&from=...&to=...&status=...
```

---

## 6. Health Checks

### 6.1 Per-Server Health Probes

Each configured MCP server gets periodic health checks:

```typescript
interface HealthCheckConfig {
  enabled: boolean;             // default: true
  intervalMs: number;           // default: 60000 (1 min)
  timeoutMs: number;            // default: 5000
  unhealthyThreshold: number;   // default: 3 consecutive failures
  healthyThreshold: number;     // default: 1 success to recover
}
```

**Probe method:**
- **stdio:** send `tools/list` request, expect response within timeout
- **SSE/HTTP:** HTTP GET to server URL, expect 200 or send `tools/list`

**States:** `healthy` → `degraded` (1-2 failures) → `unhealthy` (threshold reached)

### 6.2 Health-Aware Routing

When multi-server tool resolution is active:
- Unhealthy servers get score penalty (-0.5)
- Degraded servers get warning penalty (-0.2)
- If ALL servers for a tool are unhealthy → return error with last known status

### 6.3 Health Dashboard

```
GET /u/<user-id>/health
```

Returns:
```json
{
  "status": "healthy",
  "servers": {
    "todoist": { "status": "healthy", "latencyMs": 142, "lastCheck": "..." },
    "github": { "status": "degraded", "latencyMs": 2800, "lastCheck": "...", "failures": 1 },
    "stripe": { "status": "unhealthy", "error": "connection refused", "since": "..." }
  }
}
```

---

## 7. Hybrid Mode (Bridge-of-Bridges)

### 7.1 Concept

A local bridge instance connects to the hosted bridge as an **upstream MCP server**. The local bridge's router sees it as just another server — but it's actually a full bridge with many servers behind it.

```typescript
// Local bridge config
{
  "mode": "router",
  "servers": {
    "local-scripts": {
      "transport": "stdio",
      "command": "node",
      "args": ["my-tools.js"]
    },
    "cloud": {
      "transport": "streamable-http",
      "url": "https://bridge.aiwerk.ch/u/my-user/mcp",
      "auth": { "type": "bearer", "token": "${AIWERK_BRIDGE_KEY}" },
      "description": "AIWerk hosted bridge (todoist, github, stripe, etc.)"
    }
  }
}
```

### 7.2 Tool Resolution

The local bridge sees the upstream's tools as `cloud_todoist_find-tasks`, `cloud_github_list-issues`, etc. Intent routing works across both local and cloud tools seamlessly.

### 7.3 Advantages

- **Privacy:** sensitive tools (file access, scripts) stay local
- **Convenience:** managed tools (SaaS APIs) run in the cloud
- **Offline resilience:** local tools work even if cloud is down
- **Cost optimization:** heavy tools run locally, light ones in cloud

---

## 8. Observability

### 8.1 Why

Audit logging tells you **what** happened. Observability tells you **how well** it's working: latency, throughput, error rates, resource usage. Essential for diagnosing slowdowns, capacity planning, and SLA monitoring.

### 8.2 Metrics (Phase 2)

Export via **OpenTelemetry (OTel)** protocol + **Prometheus** `/metrics` endpoint.

**Core metrics:**

| Metric | Type | Labels |
|--------|------|--------|
| `bridge_requests_total` | counter | user, server, tool, action, status |
| `bridge_request_duration_ms` | histogram | user, server, tool |
| `bridge_errors_total` | counter | user, server, error_type |
| `bridge_cache_hits_total` | counter | user, server |
| `bridge_cache_misses_total` | counter | user, server |
| `bridge_active_connections` | gauge | transport_type |
| `bridge_rate_limit_hits_total` | counter | user, tier |
| `bridge_server_health` | gauge (0/1) | server |
| `bridge_oauth2_token_refreshes` | counter | server |

**Derived dashboards (Grafana):**
- Request rate (req/sec) per server
- p50/p95/p99 latency per tool
- Error rate % (5xx vs total)
- Cache hit ratio
- Rate limit rejection rate
- Server health status map

### 8.3 Distributed Tracing (Phase 2)

Each tool call gets a trace ID propagated through the chain:

```
Client request (trace-id: abc123)
  → Router dispatch (span: route, 2ms)
    → Transport send (span: transport, 140ms)
      → MCP server (span: tool_call, 135ms)
    → Result cache check (span: cache, 1ms)
  → Response (total: 145ms)
```

OTel trace export to Jaeger/Grafana Tempo for visualization.

### 8.4 Alerting

Built on top of metrics:
- **Error spike:** error rate > 10% for 5 minutes → alert
- **Latency spike:** p95 > 5s for 10 minutes → alert
- **Server down:** health check unhealthy for 3+ probes → alert
- **Rate limit surge:** > 50% of requests rate-limited → alert

Delivery: email (Phase 2), webhook (Phase 2), Slack/Discord (Phase 3).

### 8.5 Phase Rollout

- **Phase 1:** Basic request counting + latency in audit log (no OTel)
- **Phase 2:** Full Prometheus `/metrics` endpoint + OTel export + Grafana dashboards
- **Phase 3:** Distributed tracing + alerting

---

## 9. Deployment

### 8.1 Phase 1 (MVP)

- **Server:** AIWerk Tools VPS (46.224.187.173) or dedicated Hetzner
- **Reverse proxy:** Caddy (auto TLS)
- **Process model:** single Node.js process, worker threads per user
- **Database:** SQLite (users, secrets, audit, rate limits)
- **Domain:** bridge.aiwerk.ch
- **Monitoring:** Plausible + custom health endpoint

### 8.2 Phase 2 (Scale)

- Docker isolation for stdio servers (per-server container, not per-user)
- PostgreSQL (shared DB)
- Redis (rate limiting, session cache)
- Horizontal scaling: multiple bridge instances behind load balancer

---

## 10. Pricing Model

| Feature | Free | Pro ($9/mo) | Business ($29/mo) |
|---------|------|-------------|-------------------|
| Servers | 3 | unlimited | unlimited |
| Rate limit | 30 RPM | 120 RPM | 600 RPM |
| Audit retention | 7 days | 30 days | 90 days |
| Secret storage | 5 keys | 50 keys | unlimited |
| Hybrid mode | ❌ | ✅ | ✅ |
| RBAC | ❌ | ❌ | ✅ |
| Priority support | ❌ | email | email + chat |

---

## 11. API Reference

### 10.1 User Management

```
POST   /api/register          — create account (email, password)
POST   /api/login             — get API key
DELETE /api/account            — delete account + all data
```

### 10.2 Server Configuration

```
GET    /api/servers            — list configured servers
POST   /api/servers            — add server (from recipe or manual)
PUT    /api/servers/:name      — update server config
DELETE /api/servers/:name      — remove server
POST   /api/servers/:name/test — test server connectivity
```

### 10.3 Secret Management

```
POST   /api/secrets            — store a secret (encrypted)
GET    /api/secrets            — list secret names (NOT values)
DELETE /api/secrets/:key       — remove a secret
```

### 10.4 MCP Endpoints

```
POST   /u/:userId/mcp         — streamable-HTTP MCP endpoint
GET    /u/:userId/sse          — SSE MCP endpoint
GET    /u/:userId/health       — server health status
```

### 10.5 Admin

```
GET    /admin/users            — list users
GET    /admin/audit            — query audit logs
GET    /admin/stats            — global stats (users, calls, errors)
POST   /admin/users/:id/limit  — override rate limits
```

---

## 12. Security Checklist

### Phase 1 (MVP)
- [x] TLS everywhere (Caddy auto-cert)
- [x] API keys hashed at rest (HMAC-SHA-256 with master key)
- [x] User secrets encrypted at rest (AES-256-GCM, per-user HKDF key derivation)
- [x] Master encryption key in env var, NOT in DB or code
- [x] No plaintext secrets in logs (audit logger only logs param keys)
- [ ] Rate limiting on all endpoints
- [ ] IP-based brute force protection on /api/login
- [ ] CORS restricted to known origins
- [ ] Non-TLS remote MCP URLs rejected (no HTTP to remote hosts)
- [ ] User data fully deleted on account deletion (GDPR)

### Phase 2 (Pre-launch hardening)
- [ ] Master key backed up in `pass` (encrypted GPG store)
- [ ] VPS hardening audit (fail2ban, root login disabled, SSH key-only)
- [ ] File permissions audit (.env chmod 600, data dir 700)

### Phase 3 (Production — MANDATORY before first paid customer)
- [ ] **HashiCorp Vault on AIWerk Tools VPS** (46.224.187.173) — master key stored in Vault, never touches disk on bridge VPS; bridge retrieves key at startup via Vault API over Tailscale. Without this, a VPS root compromise exposes all user secrets.
- [ ] **Shamir Secret Sharing for Vault unseal** — Vault's own unseal key split into 3 shares (threshold 2): UbuntuPC pass store + tools VPS + offline backup
- [ ] **Key rotation** — automated 90-day master key rotation with re-encryption script for all stored secrets; old key kept in Vault for 180-day grace period
- [ ] **Database backup encryption** — SQLite backups encrypted with separate backup key before offsite transfer; backup key also stored in Vault
- [ ] **Memory protection** — encrypted swap, `mlock()` for decrypted secrets to prevent swap-to-disk leakage

> ⚠️ **Gate:** No paid tier may launch until all Phase 3 items are completed and verified. This is a business requirement, not optional hardening.

---

## 13. Migration Path

### From local bridge to hosted

1. User exports their local config: `mcp-bridge export-config > my-config.json`
2. Registers on bridge.aiwerk.ch
3. Uploads config: `POST /api/servers/import` with the config JSON
4. Secrets must be re-entered (not exported for security)
5. Replaces local bridge URL in Claude/Cursor with hosted URL

### From hosted to local

1. `GET /api/servers` returns full server configs (minus secrets)
2. User installs `@aiwerk/mcp-bridge` locally
3. Adds their own API keys to `.env`
4. Done — zero lock-in

---

## 14. Future Work

- **PII redaction** — auto-detect and mask PII in request/response (opt-in)
- **Webhook notifications** — alert on errors, rate limits, security events
- **Usage analytics dashboard** — web UI showing call patterns, costs, errors
- **Team workspaces** — shared bridge for teams with RBAC
- **Custom domains** — `bridge.mycompany.com` pointing to hosted bridge
- **Plugin marketplace** — user-contributed MCP server recipes, one-click install
- **REST-to-MCP virtualization** — wrap existing REST APIs as MCP tools via config
- **Semantic caching** — cache similar (not just identical) tool calls
