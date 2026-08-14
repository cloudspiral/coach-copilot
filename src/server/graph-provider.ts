import { composeGraph, type KnowledgeGraph } from "./graph.js";
import type { ActiveDomainGraph, DataRepository, GraphRepository } from "./repositories.js";

export interface ComposedMemberGraph {
  versionId: string;
  graph: KnowledgeGraph;
}

export class ActiveGraphProvider {
  private active: ActiveDomainGraph | null = null;
  private nextRefreshAt = 0;
  private refreshPromise: Promise<ActiveDomainGraph> | null = null;
  private lastRefreshError: string | null = null;

  constructor(
    private readonly graphs: GraphRepository,
    private readonly data: DataRepository,
    private readonly refreshMs = 30_000,
  ) {}

  async initialize(): Promise<ActiveDomainGraph> {
    return this.refresh(true);
  }

  async getActive(): Promise<ActiveDomainGraph> {
    return this.refresh(false);
  }

  async forMember(memberId: string): Promise<ComposedMemberGraph> {
    const [active, member] = await Promise.all([
      this.getActive(),
      this.data.getMember(memberId),
    ]);
    if (!member) throw new MemberNotFoundError(memberId);
    return { versionId: active.versionId, graph: composeGraph(active.graph, member) };
  }

  status(): { ready: boolean; versionId: string | null; nodes: number; edges: number; refreshError: string | null } {
    return {
      ready: Boolean(this.active),
      versionId: this.active?.versionId ?? null,
      nodes: this.active?.graph.nodes.size ?? 0,
      edges: this.active?.graph.edges.size ?? 0,
      refreshError: this.lastRefreshError,
    };
  }

  private async refresh(force: boolean): Promise<ActiveDomainGraph> {
    if (!force && this.active && Date.now() < this.nextRefreshAt) return this.active;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.loadAndSwap();
    try {
      return await this.refreshPromise;
    } catch (error) {
      if (force || !this.active) throw error;
      this.lastRefreshError = error instanceof Error ? error.message : "Unknown graph refresh error";
      this.nextRefreshAt = Date.now() + Math.min(this.refreshMs, 5_000);
      return this.active;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async loadAndSwap(): Promise<ActiveDomainGraph> {
    const loaded = await this.graphs.loadActive();
    if (!loaded) throw new Error("No active validated graph version is available");
    if (!loaded.graph.nodes.size || !loaded.graph.edges.size) throw new Error(`Active graph ${loaded.versionId} is empty`);
    this.active = loaded;
    this.lastRefreshError = null;
    this.nextRefreshAt = Date.now() + this.refreshMs;
    return loaded;
  }
}

export class MemberNotFoundError extends Error {
  constructor(memberId: string) {
    super(`Member ${memberId} not found`);
    this.name = "MemberNotFoundError";
  }
}
