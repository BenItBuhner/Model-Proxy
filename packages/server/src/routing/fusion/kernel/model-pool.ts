import type { FusionKernelFamily } from "@model-proxy/contracts/schemas/fusion.ts";

export interface PoolPick {
  family: string;
  routing: string;
}

interface RoutingStats {
  calls: number;
  failures: number;
  totalLatencyMs: number;
  /** Most recent outcomes (true = success), newest last; bounded to RELIABILITY_WINDOW. */
  recent: boolean[];
}

/** Outcomes a routing is judged on: a burst of max-band timeouts hours ago must not demote it for the rest of the process. */
const RELIABILITY_WINDOW = 12;
/** A configured primary keeps its family's first slot until it fails at least this share of its recent calls. */
const DEMOTION_RELIABILITY = 0.5;

/**
 * Model family pool. No permanent hierarchy: every family proposes and every
 * family verifies work produced by other families. Alternate routings of a
 * family (`glm-5.3-alt`) widen parallel sampling without adding correlated
 * error channels.
 *
 * Selection is deterministic for a given pool state so that an identical turn
 * compiles identical (routing, objective) work items and hits the work cache.
 * Empirical reliability only reorders a family's routings after a routing has
 * actually failed — never on success alone — and only over a recent window:
 * the configured primary stays first until it fails at least half of its
 * recent calls, because an untested alternate is not known to be better and is
 * often slower (a code-tuned alternate answering finance questions).
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
    const stats = this.stats.get(routing) ?? { calls: 0, failures: 0, totalLatencyMs: 0, recent: [] };
    stats.calls += 1;
    if (!success) stats.failures += 1;
    stats.totalLatencyMs += Math.max(0, latencyMs);
    stats.recent.push(success);
    if (stats.recent.length > RELIABILITY_WINDOW) stats.recent.splice(0, stats.recent.length - RELIABILITY_WINDOW);
    this.stats.set(routing, stats);
  }

  /** Recent-window reliability in (0, 1]. Untested routings score 1. */
  reliability(routing: string): number {
    const stats = this.stats.get(routing);
    if (stats === undefined || stats.recent.length === 0) return 1;
    // Successes never lower a routing below an untested one; one failure does
    // not zero it either (1 failure → 0.5, 1 failure in 3 → 0.75).
    const failures = stats.recent.filter((ok) => !ok).length;
    return (stats.recent.length - failures + 1) / (stats.recent.length + 1);
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
    // Round-robin across the family's routings in config order, so the n-th use
    // of a family lands on a different alternate than the (n-1)-th. A routing
    // that is failing at least half of its recent calls moves behind the ones
    // that are not; nothing else reorders the configured preference.
    const ordered = [family.routing, ...family.alt_routings]
      .map((routing, index) => ({ routing, index, failing: this.reliability(routing) <= DEMOTION_RELIABILITY }))
      .sort((a, b) => Number(a.failing) - Number(b.failing) || a.index - b.index);
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
