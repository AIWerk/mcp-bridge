#!/bin/bash
# validate-recipes.sh — Verify all recipe.json URLs are reachable (no hallucinated repos!)
# Usage: ./scripts/validate-recipes.sh [--ci]
# Exit code 1 if any URL is broken.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVERS_DIR="$SCRIPT_DIR/../servers"
CI_MODE="${1:-}"
ERRORS=0
CHECKED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "Validating recipe URLs..."
echo ""

for recipe in "$SERVERS_DIR"/*/recipe.json; do
  server=$(basename "$(dirname "$recipe")")
  
  # Extract all URLs from recipe.json
  urls=$(python3 -c "
import json, sys
d = json.load(open('$recipe'))
urls = set()
if d.get('repository'): urls.add(d['repository'])
if d.get('install', {}).get('repository'): urls.add(d['install']['repository'])
if d.get('metadata', {}).get('homepage'): urls.add(d['metadata']['homepage'])
if d.get('auth', {}).get('credentialsUrl'): urls.add(d['auth']['credentialsUrl'])
for u in sorted(urls): print(u)
" 2>/dev/null)

  # Cross-check git repos against install-server.sh
  install_script="$SCRIPT_DIR/install-server.sh"
  if [ -f "$install_script" ]; then
    # Match server name in the clone context (e.g. "wise)" or "Cloning wise")
    script_repo=$(grep -B1 -A0 -i "${server})" "$install_script" 2>/dev/null | grep -oP "git clone \Khttps://[^ ]+" | head -1 | sed 's/\.git$//')
    recipe_repo=$(python3 -c "
import json
d = json.load(open('$recipe'))
r = d.get('install', {}).get('repository', d.get('repository', ''))
print(r.rstrip('/').removesuffix('.git'))
" 2>/dev/null)
    
    if [ -n "$script_repo" ] && [ -n "$recipe_repo" ]; then
      script_repo_clean=$(echo "$script_repo" | sed 's/\.git$//')
      if [ "$recipe_repo" != "$script_repo_clean" ]; then
        echo -e "${RED}❌ MISMATCH [$server]${NC}"
        echo "   recipe.json:       $recipe_repo"
        echo "   install-server.sh: $script_repo_clean"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi

  # HTTP check all URLs
  for url in $urls; do
    CHECKED=$((CHECKED + 1))
    status=$(curl -sI -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
    # 401/403 are OK for credentialsUrl (login-protected pages)
    if [ "$status" = "000" ] || [ "$status" -ge 404 ]; then
      echo -e "${RED}❌ HTTP $status [$server] $url${NC}"
      ERRORS=$((ERRORS + 1))
    else
      echo -e "${GREEN}✓${NC} [$server] $url"
    fi
  done
done

echo ""
echo "Checked $CHECKED URLs across $(ls -d "$SERVERS_DIR"/*/recipe.json 2>/dev/null | wc -l) recipes."

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}$ERRORS error(s) found!${NC}"
  exit 1
else
  echo -e "${GREEN}All URLs valid.${NC}"
  exit 0
fi
