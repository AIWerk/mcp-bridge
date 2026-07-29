#!/usr/bin/env node
/**
 * sync-recipe-count.mjs — keep the recipe count in README.md honest.
 *
 * The README advertises how many verified, signed recipes the catalog has.
 * That number goes stale every time a recipe is added or retired in the
 * aiwerkmcp.com repo, and nothing in this repo notices. This script makes
 * the live catalog the single source of truth.
 *
 * Source of truth: GET https://bridge.aiwerk.ch/api/recipes -> `total`.
 * NOTE: the endpoint paginates with a default page size of 20, so always
 * read `total` and never `results.length`.
 *
 * Usage:
 *   node scripts/sync-recipe-count.mjs            # check only, exit 1 if stale
 *   node scripts/sync-recipe-count.mjs --write    # rewrite README to the live count
 *   node scripts/sync-recipe-count.mjs --notify   # check + bot-msg Jerome if stale
 *   node scripts/sync-recipe-count.mjs --count 41 # skip the fetch (tests / offline)
 *
 * Env:
 *   CATALOG_API_BASE  catalog API host (default: https://bridge.aiwerk.ch)
 *   JEROME_PORT       bot-msg port for jerome (default: 8801)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, '..', 'README.md');
const API_BASE = process.env.CATALOG_API_BASE ?? 'https://bridge.aiwerk.ch';
const JEROME_PORT = process.env.JEROME_PORT ?? '8801';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const notify = argv.includes('--notify');
const countFlagIndex = argv.indexOf('--count');
const countOverride = countFlagIndex !== -1 ? Number(argv[countFlagIndex + 1]) : null;

/**
 * Every place the README states the catalog size. Each rule MUST match at
 * least once, otherwise the script fails loudly: a silent no-op here is
 * exactly the failure mode this script exists to prevent (someone rewords
 * the copy, the regex stops matching, the number quietly rots again).
 */
const RULES = [
  {
    name: 'html-marker',
    pattern: /(<!-- recipe-count -->)(\d+)(<!-- \/recipe-count -->)/g,
    replace: (n) => (_m, open, _old, close) => `${open}${n}${close}`,
  },
  {
    name: 'catalog-cli-comment',
    pattern: /(# Browse )(\d+)( available servers)/g,
    replace: (n) => (_m, pre, _old, post) => `${pre}${n}${post}`,
  },
  {
    name: 'catalog-cli-comment-all',
    pattern: /(# Browse all )(\d+)( servers)/g,
    replace: (n) => (_m, pre, _old, post) => `${pre}${n}${post}`,
  },
];

async function fetchLiveCount() {
  const url = `${API_BASE}/api/recipes`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.total !== 'number') {
    throw new Error(`${url} -> response has no numeric "total" field`);
  }
  return body.total;
}

function inspect(readme) {
  const found = [];
  for (const rule of RULES) {
    const matches = [...readme.matchAll(rule.pattern)];
    if (matches.length === 0) {
      throw new Error(
        `rule "${rule.name}" matched nothing in README.md. ` +
          `The copy was reworded and this sync rule is now dead. Fix the rule.`,
      );
    }
    for (const m of matches) found.push({ rule: rule.name, value: Number(m[2]) });
  }
  return found;
}

function applyCount(readme, count) {
  let out = readme;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace(count));
  }
  return out;
}

function sendToJerome(text) {
  const payload = JSON.stringify({ to: 'jerome', text });
  try {
    execSync(
      `curl -s -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:${JEROME_PORT}/api/messages`,
      { input: payload, encoding: 'utf-8', timeout: 10_000 },
    );
  } catch (e) {
    console.error(`bot-msg failed: ${e.message}`);
  }
}

async function main() {
  const readme = readFileSync(README, 'utf-8');

  let found;
  try {
    found = inspect(readme);
  } catch (e) {
    console.error(`sync-recipe-count: ${e.message}`);
    process.exit(2);
  }

  let live;
  try {
    live = countOverride !== null ? countOverride : await fetchLiveCount();
  } catch (e) {
    console.error(`sync-recipe-count: cannot read live catalog count: ${e.message}`);
    process.exit(2);
  }

  const stale = found.filter((f) => f.value !== live);
  if (stale.length === 0) {
    console.log(`sync-recipe-count: OK, README and live catalog both say ${live} recipes.`);
    return;
  }

  const detail = stale.map((f) => `${f.rule}=${f.value}`).join(', ');

  if (write) {
    writeFileSync(README, applyCount(readme, live), 'utf-8');
    console.log(`sync-recipe-count: README updated to ${live} (was ${detail}).`);
    console.log('Reminder: the "Popular servers include:" line is NOT auto-synced, check it by hand.');
    return;
  }

  console.error(
    `sync-recipe-count: STALE. Live catalog has ${live} recipes, README says ${detail}.\n` +
      `Fix with: node scripts/sync-recipe-count.mjs --write`,
  );
  if (notify) {
    sendToJerome(
      `Brian: mcp-bridge README recipe-count elavult.\n` +
        `Live katalogus: ${live} recipe, README: ${detail}.\n` +
        `Javitas: cd ~/projects/mcp-bridge && node scripts/sync-recipe-count.mjs --write`,
    );
  }
  process.exit(1);
}

main();
