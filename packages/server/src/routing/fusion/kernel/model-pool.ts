import type { FusionKernelFamily } from "@model-proxy/contracts/schemas/fusion.ts";

export interface PoolPick {
  family: string;
  routing: string;
}

interface RoutingStats {
  calls: number;
  failures: number;
  totalLatencyMs: number;
}

/**
 * Model family pool. No permanent hierarchy: every family proposes and every
 * family verifies work produced by other families. Alternate routings of a
 * family (`glm-5.3-alt`) widen parallel sampling without adding correlated
 * error channels.
 *
 * Selection is deterministic for a given pool state so that an identical turn
 * compiles identical (routing, objective) work items and hits the work cache.
 * Empirical reliability only reorders a family's routings after a routing has
 * actually failed — never on success alone.
 */
export class ModelPool {
  private readonly families: FusionKernelFamily[];
  private readonly stats = new Map<string, RoutingStats>();

  constructor(families: FusionKernelFamily[]) {
    if (families.length === 0) throw new Error("kernel model pool requires at least one family");
    this.families = families;
  }

  get familyNames(): string[] {
    return this.families.map((f) => f.name);
  }

  get proposerFamilyCount(): number {
    return this.families.filter((f) => f.propose).length || this.families.length;
  }

  /** Choose `width` proposers: one per proposing family first, then extras cycling by weight across alt routings. */
  proposers(width: number): PoolPick[] {
    const eligible = this.families.filter((f) => f.propose);
    const pool = eligible.length > 0 ? eligible : this.families;
    const picks: PoolPick[] = [];
    const perFamilyUse = new Map<string, number>();

    for (let i = 0; i < pool.length && picks.length < width; i++) {
      const family = pool[i]!;
      picks.push({ family: family.name, routing: this.nextRouting(family, perFamilyUse) });
    }
    while (picks.length < width) {
      const family = this.pickWeighted(pool, perFamilyUse);
      picks.push({ family: family.name, routing: this.nextRouting(family, perFamilyUse) });
    }
    return picks;
  }

  /**
   * Choose `count` verifiers from families other than `candidateFamily`,
   * walking the family ring from the candidate's successor so assignments are
   * balanced and stable (glm→kimi, kimi→deepseek, deepseek→glm, …).
   */
  verifiersFor(candidateFamily: string, count: number, exclude: Set<string> = new Set()): PoolPick[] {
    const eligible = this.families.filter((f) => f.verify);
    const pool = eligible.length > 0 ? eligible : this.families;
    const candidateIndex = Math.max(0, this.families.findIndex((f) => f.name === candidateFamily));
    const ring = [...this.families.slice(candidateIndex + 1), ...this.families.slice(0, candidateIndex + 1)]
      .filter((f) => pool.includes(f));
    const others = ring.filter((f) => f.name !== candidateFamily && !exclude.has(f.name));
    const ordered = others.length > 0 ? others : ring.length > 0 ? ring : pool;
    const picks: PoolPick[] = [];
    const perFamilyUse = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const family = ordered[i % ordered.length]!;
      picks.push({ family: family.name, routing: this.nextRouting(family, perFamilyUse) });
    }
    return picks;
  }

  recordOutcome(routing: string, success: boolean, latencyMs: number): void {
    const stats = this.stats.get(routing) ?? { calls: 0, failures: 0, totalLatencyMs: 0 };
    stats.calls += 1;
    if (!success) stats.failures += 1;
    stats.totalLatencyMs += Math.max(0, latencyMs);
    this.stats.set(routing, stats);
  }

  reliability(routing: string): number {
    const stats = this.stats.get(routing);
    if (stats === undefined || stats.calls === 0) return 1;
    // Successes never lower a routing below an untested one; one failure does
    // not zero it either (1 failure → 0.5, 1 failure in 3 → 0.75).
    return (stats.calls - stats.failures + 1) / (stats.calls + 1);
  }

  snapshot(): Record<string, { calls: number; failures: number; avgLatencyMs: number }> {
    const out: Record<string, { calls: number; failures: number; avgLatencyMs: number }> = {};
    for (const [routing, stats] of this.stats) {
      out[routing] = {
        calls: stats.calls,
        failures: stats.failures,
        avgLatencyMs: stats.calls > 0 ? Math.round(stats.totalLatencyMs / stats.calls) : 0,
      };
    }
    return out;
  }

  private nextRouting(family: FusionKernelFamily, perFamilyUse: Map<string, number>): string {
    const used = perFamilyUse.get(family.name) ?? 0;
    perFamilyUse.set(family.name, used + 1);
    // Round-robin across the family's routings, most reliable first, so the
    // n-th use of a family lands on a different alternate than the (n-1)-th.
    const ordered = [family.routing, ...family.alt_routings]
      .map((routing, index) => ({ routing, index }))
      .sort((a, b) => this.reliability(b.routing) - this.reliability(a.routing) || a.index - b.index);
    return ordered[used % ordered.length]!.routing;
  }

  private pickWeighted(pool: FusionKernelFamily[], perFamilyUse: Map<string, number>): FusionKernelFamily {
    let best = pool[0]!;
    let bestScore = -Infinity;
    for (const family of pool) {
      const used = perFamilyUse.get(family.name) ?? 0;
      const capacity = 1 + family.alt_routings.length;
      // Favor families with spare alternate routings and fewer uses so far;
      // strictly greater keeps ties on the first family in config order.
      const score = (family.weight * capacity) / (used + 1);
      if (score > bestScore) {
        bestScore = score;
        best = family;
      }
    }
    return best;
  }
}
