#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect OpenClaw plugin or standalone mode
OPENCLAW_JSON="${HOME}/.openclaw/openclaw.json"
OPENCLAW_PLUGIN_DIR="${HOME}/.openclaw/extensions/openclaw-mcp-bridge"
if [[ -f "$OPENCLAW_JSON" ]] && python3 -c "
import json
with open('$OPENCLAW_JSON') as f:
    c = json.load(f)
assert 'openclaw-mcp-bridge' in c.get('plugins',{}).get('entries',{})
" 2>/dev/null; then
    CONFIG_MODE="openclaw"
    MCP_BRIDGE_DIR="$OPENCLAW_PLUGIN_DIR"
    MCP_BRIDGE_JSON="$OPENCLAW_JSON"
    ENV_FILE="${HOME}/.openclaw/.env"
    echo "[mcp-bridge] Detected OpenClaw plugin mode"
else
    CONFIG_MODE="standalone"
    MCP_BRIDGE_DIR="${HOME}/.mcp-bridge"
    MCP_BRIDGE_JSON="${MCP_BRIDGE_DIR}/config.json"
    ENV_FILE="${MCP_BRIDGE_DIR}/.env"
fi

usage() {
    echo "Usage: $0 <server-name> [--dry-run] [--remove]"
    echo ""
    echo "Available servers:"
    for server_dir in "$SCRIPT_DIR/../servers"/*; do
        [[ -d "$server_dir" ]] && echo "  - $(basename "$server_dir")"
    done
    exit 1
}

[[ $# -eq 0 ]] && usage

SERVER_NAME="$1"
DRY_RUN=false
REMOVE=false
shift
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true ;;
        --remove)  REMOVE=true ;;
    esac
    shift
done

SERVER_DIR="$SCRIPT_DIR/../servers/$SERVER_NAME"
if [[ ! -d "$SERVER_DIR" ]]; then
    echo "Error: Server '$SERVER_NAME' not found."
    usage
fi

SERVER_TITLE="$(tr '-' ' ' <<<"$SERVER_NAME" | awk '{for(i=1;i<=NF;i++){$i=toupper(substr($i,1,1))substr($i,2)};print}')"
ENV_VARS_FILE="$SERVER_DIR/env_vars"

# Prefer recipe.json (v2) over config.json (v1) when both exist
RECIPE_FILE="$SERVER_DIR/recipe.json"
SERVER_CONFIG_FILE="$SERVER_DIR/config.json"
RECIPE_FORMAT="v1"
if [[ -f "$RECIPE_FILE" ]]; then
    RECIPE_FORMAT="v2"
elif [[ ! -f "$SERVER_CONFIG_FILE" ]]; then
    echo "Error: No recipe.json or config.json found in $SERVER_DIR"
    exit 1
fi

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "❌ Missing required command: $1"
        exit 1
    fi
}

get_token_url() {
    # For v2 recipes, prefer credentialsUrl from auth block
    if [[ "$RECIPE_FORMAT" == "v2" ]]; then
        local url
        url=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)
print(r.get('auth', {}).get('credentialsUrl', ''))
" "$RECIPE_FILE" 2>/dev/null)
        [[ -n "$url" ]] && echo "$url" && return
    fi
    # v1 fallback: hardcoded URLs
    case "$SERVER_NAME" in
        apify)       echo "https://console.apify.com/settings/integrations" ;;
        github)      echo "https://github.com/settings/tokens" ;;
        google-maps) echo "https://console.cloud.google.com/apis/credentials" ;;
        hetzner)     echo "https://console.hetzner.cloud/" ;;
        hostinger)   echo "https://hpanel.hostinger.com/api" ;;
        linear)      echo "https://linear.app/settings/api" ;;
        miro)        echo "https://miro.com/app/settings/user-profile/apps" ;;
        notion)      echo "https://www.notion.so/my-integrations" ;;
        stripe)      echo "https://dashboard.stripe.com/apikeys" ;;
        tavily)      echo "https://app.tavily.com/home" ;;
        todoist)     echo "https://app.todoist.com/app/settings/integrations/developer" ;;
        wise)        echo "https://wise.com/settings/api-tokens" ;;
        *)           echo "" ;;
    esac
}

check_prerequisites() {
    case "$SERVER_NAME" in
        github)
            require_cmd docker ;;
        linear|wise|hetzner)
            require_cmd node; require_cmd npm ;;
        *)
            require_cmd node; require_cmd npx ;;
    esac
}

install_dependencies() {
    case "$SERVER_NAME" in
        github)
            echo "Pulling GitHub MCP server Docker image..."
            docker pull ghcr.io/github/github-mcp-server ;;
        linear)
            local clone_dir="$HOME/.openclaw/mcp-servers/linear-mcp"
            mkdir -p "$HOME/.openclaw/mcp-servers"
            echo "Installing linear MCP server..."
            npm install --prefix "$clone_dir" @anthropic-pb/linear-mcp-server ;;
        wise)
            # Clone outside plugin tree to avoid nested node_modules TS path conflicts
            local clone_dir="$HOME/.openclaw/mcp-servers/wise-mcp"
            mkdir -p "$HOME/.openclaw/mcp-servers"
            if [ -d "$clone_dir/.git" ]; then
                echo "Updating wise mcp-server..."; git -C "$clone_dir" pull --ff-only
            else
                echo "Cloning wise mcp-server..."; git clone https://github.com/Szotasz/wise-mcp.git "$clone_dir"
            fi
            echo "Building wise mcp-server..."
            (cd "$clone_dir" && npm install && npm run build) ;;
        hetzner)
            # Clone outside plugin tree to avoid nested node_modules TS path conflicts
            local clone_dir="$HOME/.openclaw/mcp-servers/mcp-hetzner"
            mkdir -p "$HOME/.openclaw/mcp-servers"
            if [ -d "$clone_dir/.git" ]; then
                echo "Updating hetzner mcp-server..."; git -C "$clone_dir" pull --ff-only
            else
                echo "Cloning hetzner mcp-server..."; git clone https://github.com/dkruyt/mcp-hetzner.git "$clone_dir"
            fi
            echo "Building hetzner mcp-server..."
            (cd "$clone_dir" && npm install && npm run build) ;;
    esac
}

resolve_path_override() {
    case "$SERVER_NAME" in
        linear)
            local lin_dir="$HOME/.openclaw/mcp-servers/linear-mcp/node_modules/@anthropic-pb/linear-mcp-server"
            if [ -f "$lin_dir/dist/index.js" ]; then
                echo "$lin_dir/dist/index.js"
            else
                echo "$lin_dir/build/index.js"
            fi ;;
        wise)   echo "$HOME/.openclaw/mcp-servers/wise-mcp/dist/cli.js" ;;
        hetzner) echo "$HOME/.openclaw/mcp-servers/mcp-hetzner/dist/index.js" ;;
        *)      echo "" ;;
    esac
}

# ========================================
# REMOVE MODE
# ========================================
if [[ "$REMOVE" == "true" ]]; then
    echo "========================================"
    echo "Removing ${SERVER_TITLE} MCP Server"
    echo "========================================"

    if [[ ! -f "$MCP_BRIDGE_JSON" ]]; then
        echo "❌ Config not found: $MCP_BRIDGE_JSON"
        exit 1
    fi

    # Check if server exists in config
    HAS_SERVER=$(python3 -c "
import json, sys
server_name = sys.argv[1]
config_path = sys.argv[2]
config_mode = sys.argv[3]
with open(config_path) as f:
    cfg = json.load(f)
if config_mode == 'openclaw':
    servers = cfg.get('plugins',{}).get('entries',{}).get('openclaw-mcp-bridge',{}).get('config',{}).get('servers',{})
else:
    servers = cfg.get('servers',{})
print('yes' if server_name in servers else 'no')
" "$SERVER_NAME" "$MCP_BRIDGE_JSON" "$CONFIG_MODE" 2>/dev/null)

    if [[ "$HAS_SERVER" != "yes" ]]; then
        echo "ℹ️  Server '$SERVER_NAME' not found in config. Nothing to remove."
        exit 0
    fi

    # Backup
    BACKUP_FILE="${MCP_BRIDGE_JSON}.bak-$(date +%Y%m%d%H%M%S)"
    cp "$MCP_BRIDGE_JSON" "$BACKUP_FILE"
    echo "Backup: ${BACKUP_FILE}"

    # Remove server entry from config (keep servers/<name>/ directory)
    python3 -c "
import json, sys
server_name = sys.argv[1]
config_path = sys.argv[2]
config_mode = sys.argv[3]
with open(config_path) as f:
    cfg = json.load(f)
if config_mode == 'openclaw':
    servers = cfg['plugins']['entries']['openclaw-mcp-bridge']['config']['servers']
else:
    servers = cfg.get('servers', {})
del servers[server_name]
with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
print(f'✅ Removed {server_name} from config')
print(f'ℹ️  Server recipe kept in servers/{server_name}/ (reinstall anytime)')
" "$SERVER_NAME" "$MCP_BRIDGE_JSON" "$CONFIG_MODE" 2>/dev/null

    # Remove env var from .env if exists
    REMOVE_ENV_VAR=""
    if [[ "$RECIPE_FORMAT" == "v2" ]]; then
        REMOVE_ENV_VAR=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)
env_vars = r.get('auth', {}).get('envVars', [])
print(env_vars[0] if env_vars else '')
" "$RECIPE_FILE" 2>/dev/null)
    elif [[ -f "$ENV_VARS_FILE" ]] && [[ -s "$ENV_VARS_FILE" ]]; then
        REMOVE_ENV_VAR="$(head -n 1 "$ENV_VARS_FILE" | tr -d '[:space:]')"
    fi
    if [[ -n "$REMOVE_ENV_VAR" ]] && [[ -f "$ENV_FILE" ]]; then
        if grep -q "^${REMOVE_ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
            sed -i "/^${REMOVE_ENV_VAR}=/d" "$ENV_FILE"
            echo "🔑 Removed ${REMOVE_ENV_VAR} from ${ENV_FILE}"
        fi
    fi

    # Restart
    echo ""
    RESTART="y"
    if [ -e /dev/tty ]; then
        read -r -p "Restart gateway now? [Y/n]: " RESTART </dev/tty
    fi
    if [[ -z "$RESTART" || "$RESTART" =~ ^[Yy]$ ]]; then
        systemctl --user restart mcp-bridge 2>/dev/null || {
            echo "⚠️  Auto-restart failed. Run: systemctl --user restart mcp-bridge"
            exit 0
        }
        sleep 3
        if systemctl --user is-active --quiet mcp-bridge 2>/dev/null; then
            echo "✅ Service restarted. ${SERVER_TITLE} removed."
        else
            echo "❌ Service failed to start! Restoring backup..."
            cp "$BACKUP_FILE" "$MCP_BRIDGE_JSON"
            systemctl --user restart mcp-bridge 2>/dev/null
            echo "Restored from backup."
        fi
    else
        echo "⏭️  Run manually: systemctl --user restart mcp-bridge"
    fi
    exit 0
fi

# ========================================
# INSTALL MODE
# ========================================
echo "========================================"
echo "Installing ${SERVER_TITLE} MCP Server"
echo "========================================"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY RUN] Server: $SERVER_NAME"
    echo "[DRY RUN] Recipe format: $RECIPE_FORMAT"
    if [[ "$RECIPE_FORMAT" == "v2" ]]; then
        ENV_VAR_LIST=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)
print(', '.join(r.get('auth', {}).get('envVars', [])))
" "$RECIPE_FILE" 2>/dev/null)
        [[ -n "$ENV_VAR_LIST" ]] && echo "[DRY RUN] Env vars (from auth.envVars): $ENV_VAR_LIST"
        echo "[DRY RUN] Recipe (v2):"; cat "$RECIPE_FILE"
    else
        [[ -f "$ENV_VARS_FILE" ]] && echo "[DRY RUN] Env var: $(cat "$ENV_VARS_FILE")"
        echo "[DRY RUN] Config (v1):"; cat "$SERVER_CONFIG_FILE"
    fi
    exit 0
fi

# 1. Check prerequisites
check_prerequisites

# 2. Install server-specific dependencies
install_dependencies

# 3. Get API token
# Determine env var name: v2 uses auth.envVars[], v1 uses env_vars file
ENV_VAR_NAME=""
if [[ "$RECIPE_FORMAT" == "v2" ]]; then
    ENV_VAR_NAME=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)
env_vars = r.get('auth', {}).get('envVars', [])
print(env_vars[0] if env_vars else '')
" "$RECIPE_FILE" 2>/dev/null)
elif [[ -f "$ENV_VARS_FILE" ]] && [[ -s "$ENV_VARS_FILE" ]]; then
    ENV_VAR_NAME="$(head -n 1 "$ENV_VARS_FILE" | tr -d '[:space:]')"
fi

# Check if this is an OAuth2 Authorization Code server (browser login, not API key)
OAUTH2_AUTH_CODE="false"
if [[ "$RECIPE_FORMAT" == "v2" ]]; then
    OAUTH2_AUTH_CODE=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)
auth = r.get('auth', {})
# OAuth2 auth code: explicitly requires grantType=authorization_code
# and no envVars (login via browser, not API key)
if auth.get('type') == 'oauth2' and auth.get('grantType') == 'authorization_code':
    if not auth.get('envVars'):
        print('true')
    else:
        print('false')
else:
    print('false')
" "$RECIPE_FILE" 2>/dev/null)
fi

if [[ "$OAUTH2_AUTH_CODE" == "true" ]]; then
    echo ""
    echo "🔐 This server uses OAuth2 browser login (no API key needed)."
    echo "After config is saved, we'll open your browser for authentication."
    SKIP_TOKEN_PROMPT="true"
elif [[ -n "$ENV_VAR_NAME" ]]; then
    TOKEN_URL="$(get_token_url)"
    [[ -n "$TOKEN_URL" ]] && echo "Get your API token here: ${TOKEN_URL}"

    TOKEN=""
    while [ -z "$TOKEN" ]; do
        read -r -p "Enter your ${SERVER_TITLE} API token: " TOKEN </dev/tty
        [[ -z "$TOKEN" ]] && echo "Token cannot be empty."
    done

    # Write to .env
    mkdir -p "$MCP_BRIDGE_DIR"
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"

    if grep -q "^${ENV_VAR_NAME}=" "$ENV_FILE" 2>/dev/null; then
        echo "${ENV_VAR_NAME} already exists in ${ENV_FILE}."
        read -r -p "Overwrite with new token? [y/N]: " OVERWRITE </dev/tty
        if [[ "$OVERWRITE" =~ ^[Yy]$ ]]; then
            sed -i "/^${ENV_VAR_NAME}=/d" "$ENV_FILE"
            echo "${ENV_VAR_NAME}=${TOKEN}" >> "$ENV_FILE"
            echo "✅ Updated ${ENV_VAR_NAME} in ${ENV_FILE}"
        else
            echo "Keeping existing value."
        fi
    else
        echo "${ENV_VAR_NAME}=${TOKEN}" >> "$ENV_FILE"
        echo "✅ Saved ${ENV_VAR_NAME} to ${ENV_FILE}"
    fi
fi

# 4. Backup and merge config.json
mkdir -p "$(dirname "$MCP_BRIDGE_JSON")"
[[ ! -f "$MCP_BRIDGE_JSON" ]] && echo "{}" > "$MCP_BRIDGE_JSON"

BACKUP_FILE="${MCP_BRIDGE_JSON}.bak-$(date +%Y%m%d%H%M%S)"
cp "$MCP_BRIDGE_JSON" "$BACKUP_FILE"
echo "Backup: ${BACKUP_FILE}"

PATH_OVERRIDE="$(resolve_path_override)"
ACTIVE_RECIPE_FILE="$RECIPE_FILE"
ACTIVE_RECIPE_FORMAT="$RECIPE_FORMAT"

python3 - "$MCP_BRIDGE_JSON" "$SERVER_CONFIG_FILE" "$SERVER_NAME" "$PATH_OVERRIDE" "$ACTIVE_RECIPE_FILE" "$ACTIVE_RECIPE_FORMAT" <<'PY'
import json, sys

config_path, server_cfg_path, server_name, path_override, recipe_file, recipe_format = sys.argv[1:7]

with open(config_path, "r", encoding="utf-8") as f:
    raw = f.read().strip()
    cfg = json.loads(raw) if raw else {}

if recipe_format == "v2":
    # Parse v2 recipe and build v1-compatible server config for runtime
    with open(recipe_file, "r", encoding="utf-8") as f:
        recipe = json.load(f)
    transport = recipe["transports"][0]
    server_cfg = {
        "schemaVersion": 1,
        "name": server_name,
        "transport": transport.get("type", "stdio"),
        "command": transport.get("command", ""),
        "args": transport.get("args", []),
        "env": transport.get("env", {}),
    }
    # Carry over optional v1-compatible fields from recipe if present
    auth = recipe.get("auth", {})
    if auth.get("required"):
        server_cfg["authRequired"] = True
    if auth.get("credentialsUrl"):
        server_cfg["credentialsUrl"] = auth["credentialsUrl"]
    meta = recipe.get("metadata", {})
    if meta.get("homepage"):
        server_cfg["homepage"] = meta["homepage"]
else:
    with open(server_cfg_path, "r", encoding="utf-8") as f:
        server_cfg = json.load(f)

if path_override:
    args = server_cfg.get("args")
    if isinstance(args, list):
        for idx, value in enumerate(args):
            if isinstance(value, str) and value.startswith("path/to/"):
                args[idx] = path_override

cfg.setdefault("toolPrefix", True)
cfg.setdefault("reconnectIntervalMs", 30000)
cfg.setdefault("connectionTimeoutMs", 10000)
cfg.setdefault("requestTimeoutMs", 60000)
servers = cfg.setdefault("servers", {})
servers[server_name] = server_cfg

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

print(f"✅ Configuration merged for: {server_name} (recipe {recipe_format})")
PY

# 5. OAuth2 browser login (if applicable)
if [[ "$OAUTH2_AUTH_CODE" == "true" ]]; then
    echo ""
    echo "🔐 Starting OAuth2 login for ${SERVER_TITLE}..."

    # Find the mcp-bridge CLI
    MCP_BRIDGE_BIN=""
    if command -v mcp-bridge &>/dev/null; then
        MCP_BRIDGE_BIN="mcp-bridge"
    elif [[ -x "$(dirname "$0")/../dist/bin/mcp-bridge.js" ]]; then
        MCP_BRIDGE_BIN="node $(dirname "$0")/../dist/bin/mcp-bridge.js"
    elif command -v npx &>/dev/null; then
        MCP_BRIDGE_BIN="npx @aiwerk/mcp-bridge"
    fi

    if [[ -n "$MCP_BRIDGE_BIN" ]]; then
        # Detect if we have a browser available
        if command -v xdg-open &>/dev/null || command -v open &>/dev/null || command -v wslview &>/dev/null; then
            echo "Opening browser for authentication..."
            $MCP_BRIDGE_BIN auth login "$SERVER_NAME"
        else
            echo "No browser detected (headless environment)."
            echo "Using device code flow — follow the instructions below:"
            $MCP_BRIDGE_BIN auth login "$SERVER_NAME" --device-code
        fi
    else
        echo "⚠️  mcp-bridge CLI not found. Run manually after install:"
        echo "   mcp-bridge auth login ${SERVER_NAME}"
    fi
fi

# 6. Gateway restart
echo ""
echo "✅ ${SERVER_TITLE} MCP Server installed."
echo "Restart mcp-bridge to pick up the new server configuration."
