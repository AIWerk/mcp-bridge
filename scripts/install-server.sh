#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_BRIDGE_DIR="${HOME}/.mcp-bridge"
MCP_BRIDGE_JSON="${MCP_BRIDGE_DIR}/config.json"
ENV_FILE="${MCP_BRIDGE_DIR}/.env"

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
SERVER_CONFIG_FILE="$SERVER_DIR/config.json"
ENV_VARS_FILE="$SERVER_DIR/env_vars"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "❌ Missing required command: $1"
        exit 1
    fi
}

get_token_url() {
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
            echo "Installing @anthropic-pb/linear-mcp-server globally..."
            npm install -g @anthropic-pb/linear-mcp-server ;;
        wise)
            local clone_dir="$SERVER_DIR/mcp-server"
            if [ -d "$clone_dir/.git" ]; then
                echo "Updating wise mcp-server..."; git -C "$clone_dir" pull --ff-only
            else
                echo "Cloning wise mcp-server..."; git clone https://github.com/Szotasz/wise-mcp.git "$clone_dir"
            fi
            echo "Building wise mcp-server..."
            (cd "$clone_dir" && npm install && npm run build) ;;
        hetzner)
            local clone_dir="$SERVER_DIR/mcp-server"
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
            local npm_root; npm_root="$(npm root -g)"
            if [ -f "$npm_root/@anthropic-pb/linear-mcp-server/dist/index.js" ]; then
                echo "$npm_root/@anthropic-pb/linear-mcp-server/dist/index.js"
            else
                echo "$npm_root/@anthropic-pb/linear-mcp-server/build/index.js"
            fi ;;
        wise)   echo "$SERVER_DIR/mcp-server/dist/cli.js" ;;
        hetzner) echo "$SERVER_DIR/mcp-server/dist/index.js" ;;
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
with open(config_path) as f:
    cfg = json.load(f)
servers = cfg.get('servers',{})
print('yes' if server_name in servers else 'no')
" "$SERVER_NAME" "$MCP_BRIDGE_JSON" 2>/dev/null)

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
with open(config_path) as f:
    cfg = json.load(f)
servers = cfg.get('servers', {})
del servers[server_name]
with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
print(f'✅ Removed {server_name} from config')
print(f'ℹ️  Server recipe kept in servers/{server_name}/ (reinstall anytime)')
" "$SERVER_NAME" "$MCP_BRIDGE_JSON" 2>/dev/null

    # Remove env var from .env if exists
    if [[ -f "$ENV_VARS_FILE" ]] && [[ -s "$ENV_VARS_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
        ENV_VAR_NAME="$(head -n 1 "$ENV_VARS_FILE" | tr -d '[:space:]')"
        if grep -q "^${ENV_VAR_NAME}=" "$ENV_FILE" 2>/dev/null; then
            sed -i "/^${ENV_VAR_NAME}=/d" "$ENV_FILE"
            echo "🔑 Removed ${ENV_VAR_NAME} from ${ENV_FILE}"
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
    [[ -f "$ENV_VARS_FILE" ]] && echo "[DRY RUN] Env var: $(cat "$ENV_VARS_FILE")"
    echo "[DRY RUN] Config:"; cat "$SERVER_CONFIG_FILE"
    exit 0
fi

# 1. Check prerequisites
check_prerequisites

# 2. Install server-specific dependencies
install_dependencies

# 3. Get API token
if [[ -f "$ENV_VARS_FILE" ]] && [[ -s "$ENV_VARS_FILE" ]]; then
    ENV_VAR_NAME="$(head -n 1 "$ENV_VARS_FILE" | tr -d '[:space:]')"

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

python3 - "$MCP_BRIDGE_JSON" "$SERVER_CONFIG_FILE" "$SERVER_NAME" "$PATH_OVERRIDE" <<'PY'
import json, sys

config_path, server_cfg_path, server_name, path_override = sys.argv[1:5]

with open(config_path, "r", encoding="utf-8") as f:
    raw = f.read().strip()
    cfg = json.loads(raw) if raw else {}

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

print(f"✅ Configuration merged for: {server_name}")
PY

# 5. Gateway restart
echo ""
echo "✅ ${SERVER_TITLE} MCP Server installed."
echo "Restart mcp-bridge to pick up the new server configuration."
