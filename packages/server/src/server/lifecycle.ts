const startedAt = Date.now();

let draining = false;
let drainSignal: string | undefined;
let drainStartedAt: string | undefined;

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

export function isDraining(): boolean {
  return draining;
}

export function markDraining(signal: string): void {
  if (draining) return;
  draining = true;
  drainSignal = signal;
  drainStartedAt = new Date().toISOString();
}

export function deploymentState(): {
  instance_color: string;
  build_id: string;
  pid: number;
  uptime_seconds: number;
  draining: boolean;
  drain_signal?: string;
  drain_started_at?: string;
} {
  return {
    instance_color: process.env.MODEL_PROXY_INSTANCE_COLOR ?? "single",
    build_id: process.env.MODEL_PROXY_BUILD_ID ?? "local",
    pid: process.pid,
    uptime_seconds: uptimeSeconds(),
    draining,
    ...(drainSignal !== undefined ? { drain_signal: drainSignal } : {}),
    ...(drainStartedAt !== undefined ? { drain_started_at: drainStartedAt } : {}),
  };
}
