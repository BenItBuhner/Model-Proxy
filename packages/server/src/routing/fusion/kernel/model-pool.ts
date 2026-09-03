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
 * error channels; extra width beyond the family count is distributed by
 * weight, penalizing routings with recent failures.
 */
export class ModelPool {
  private readonly families: FusionKernelFamily[];
  private readonly stats = new Map<string, RoutingStats>();
  private rotation = 0;

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

  /** Choose `width` proposers: one per proposing family first, then weighted extras across alt routings. */
  proposers(width: number): PoolPick[] {
    const eligible = this.families.filter((f) => f.propose);
    const pool = eligible.length > 0 ? eligible : this.families;
    const picks: PoolPick[] = [];
    const perFamilyUse = new Map<string, number>();
    const start = this.rotation++ % pool.length;

    // Round 1: every family exactly once, rotated so the same family does not
    // always lead the wave.
    for (let i = 0; i < pool.length && picks.length < width; i++) {
      const family = pool[(start + i) % pool.length]!;
      picks.push({ family: family.name, routing: this.nextRouting(family, perFamilyUse) });
    }
    // Extra width: weighted by config weight and by empirical reliability.
    while (picks.length < width) {
      const family = this.pickWeighted(pool, perFamilyUse);
      picks.push({ family: family.name, routing: this.nextRouting(family, perFamilyUse) });
    }
    return picks;
  }

  /** Choose `count` verifiers from families other than `candidateFamily` (falls back to same family alternates). */
  verifiersFor(candidateFamily: string, count: number, exclude: Set<string> = new Set()): PoolPick[] {
    const eligible = this.families.filter((f) => f.verify);
    const pool = eligible.length > 0 ? eligible : this.families;
    const others = pool.filter((f) => f.name !== candidateFamily && !exclude.has(f.name));
    const ordered = others.length > 0 ? others : pool;
    const picks: PoolPick[] = [];
    const perFamilyUse = new Map<string, number>();
    const start = this.rotation++ % ordered.length;
    for (let i = 0; i < count; i++) {
      const family = ordered[(start + i) % ordered.length]!;
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
    // Laplace-smoothed success rate so one failure does not zero a routing.
    return (stats.calls - stats.failures + 1) / (stats.calls + 2);
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
      const reliability = this.reliability(family.routing);
      // Favor families with spare alternate routings and fewer uses so far.
      const score = (family.weight * reliability * capacity) / (used + 1);
      if (score > bestScore) {
        bestScore = score;
        best = family;
      }
    }
    return best;
  }
}
