interface RegisteredTool {
  server: string;
  tool: string;
  inputSchema: any;
}

export interface ToolResolutionCandidate {
  server: string;
  tool: string;
  score: number;
  suggested?: true;
}

export type ToolResolutionResult =
  | { server: string; tool: string }
  | {
      ambiguous: true;
      message: string;
      candidates: ToolResolutionCandidate[];
    }
  | null;

const RECENT_CALL_LIMIT = 5;
const BASE_PRIORITY_STEP = 0.1;
const BASE_PRIORITY_MIN = 0.1;
const RECENCY_BOOST = 0.3;
const PARAM_MATCH_WEIGHT = 0.2;
const AUTO_RESOLVE_DELTA = 0.15;

export class ToolResolver {
  private readonly basePriority = new Map<string, number>();
  private readonly toolsByName = new Map<string, RegisteredTool[]>();
  private readonly toolNamesByServer = new Map<string, Set<string>>();
  private readonly recentCalls: Array<{ server: string; tool: string }> = [];

  constructor(serverOrder: string[]) {
    const reversed = [...serverOrder].reverse();
    reversed.forEach((server, index) => {
      const score = Math.max(1.0 - (index * BASE_PRIORITY_STEP), BASE_PRIORITY_MIN);
      this.basePriority.set(server, score);
    });
  }

  registerServerTools(server: string, tools: Array<{ name: string; inputSchema: any }>): void {
    this.removeServer(server);

    const names = new Set<string>();
    for (const tool of tools) {
      if (!tool?.name) continue;

      const registered: RegisteredTool = {
        server,
        tool: tool.name,
        inputSchema: tool.inputSchema
      };
      const existing = this.toolsByName.get(tool.name) ?? [];
      existing.push(registered);
      this.toolsByName.set(tool.name, existing);
      names.add(tool.name);
    }

    this.toolNamesByServer.set(server, names);
  }

  removeServer(server: string): void {
    const previousNames = this.toolNamesByServer.get(server);
    if (previousNames) {
      for (const toolName of previousNames) {
        const filtered = (this.toolsByName.get(toolName) ?? []).filter((entry) => entry.server !== server);
        if (filtered.length === 0) {
          this.toolsByName.delete(toolName);
          continue;
        }
        this.toolsByName.set(toolName, filtered);
      }
    }
    this.toolNamesByServer.delete(server);
  }

  resolve(toolName: string, params?: Record<string, unknown>, serverHint?: string): ToolResolutionResult {
    const candidates = this.toolsByName.get(toolName) ?? [];
    if (candidates.length === 0) {
      return null;
    }

    if (serverHint) {
      const explicit = candidates.find((candidate) => candidate.server === serverHint);
      if (!explicit) {
        return null;
      }
      return { server: explicit.server, tool: explicit.tool };
    }

    if (candidates.length === 1) {
      return { server: candidates[0].server, tool: candidates[0].tool };
    }

    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: this.scoreCandidate(candidate.server, candidate.inputSchema, params)
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return (this.basePriority.get(b.server) ?? BASE_PRIORITY_MIN) - (this.basePriority.get(a.server) ?? BASE_PRIORITY_MIN);
      });

    const first = scored[0];
    const second = scored[1];
    if (!second || (first.score - second.score) >= AUTO_RESOLVE_DELTA) {
      return { server: first.server, tool: first.tool };
    }

    return {
      ambiguous: true,
      message: `Multiple servers provide '${toolName}'. Please specify server=`,
      candidates: scored.map((candidate, index) => ({
        server: candidate.server,
        tool: candidate.tool,
        score: Number(candidate.score.toFixed(2)),
        ...(index === 0 ? { suggested: true as const } : {})
      }))
    };
  }

  recordCall(server: string, tool: string): void {
    this.recentCalls.push({ server, tool });
    if (this.recentCalls.length > RECENT_CALL_LIMIT) {
      this.recentCalls.shift();
    }
  }

  getKnownToolNames(): string[] {
    return [...this.toolsByName.keys()];
  }

  clear(): void {
    this.toolsByName.clear();
    this.toolNamesByServer.clear();
    this.recentCalls.length = 0;
  }

  private scoreCandidate(server: string, inputSchema: any, params?: Record<string, unknown>): number {
    const base = this.basePriority.get(server) ?? BASE_PRIORITY_MIN;
    const recency = this.wasUsedRecently(server) ? RECENCY_BOOST : 0;
    const paramMatch = this.computeParamMatch(inputSchema, params) * PARAM_MATCH_WEIGHT;
    return base + recency + paramMatch;
  }

  private wasUsedRecently(server: string): boolean {
    return this.recentCalls.some((call) => call.server === server);
  }

  private computeParamMatch(inputSchema: any, params?: Record<string, unknown>): number {
    if (!params || typeof params !== "object") {
      return 0;
    }

    const paramNames = Object.keys(params);
    if (paramNames.length === 0) {
      return 0;
    }

    const schemaProperties = inputSchema?.properties;
    if (!schemaProperties || typeof schemaProperties !== "object") {
      return 0;
    }

    const propertyNames = new Set(Object.keys(schemaProperties));
    if (propertyNames.size === 0) {
      return 0;
    }

    const matching = paramNames.filter((paramName) => propertyNames.has(paramName)).length;
    return matching / paramNames.length;
  }
}
