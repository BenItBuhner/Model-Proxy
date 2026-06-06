/**
 * Event shapes sent by the proxy over `/v1/admin/events/:requestId/stream`.
 * Mirrors `src/observability/event-sink.ts::RequestEvent` on the server.
 * Intentionally narrowly typed so components can render by `type` with
 * exhaustive switches.
 */

export type RequestEvent =
  | {
      type: "request.started";
      at: string;
      protocol: "openai" | "anthropic" | "audio";
      endpoint: string;
      model: string;
      stream: boolean;
      enforceEnabled: boolean;
    }
  | {
      type: "route.attempted";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      wireProtocol: "openai" | "anthropic" | "audio";
      isFallback: boolean;
      keyHint: string;
      apiKeyEnvVar?: string;
      egressProxyEnvVar?: string;
      egressProxyHint?: string;
    }
  | {
      type: "route.succeeded";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      latencyMs: number;
    }
  | {
      type: "route.failed";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      status?: number;
      errorType: string;
      message: string;
      willFallback: boolean;
    }
  | {
      type: "key.cooldown";
      at: string;
      provider: string;
      model: string;
      action: string;
      cooldownSeconds?: number;
    }
  | {
      type: "proxy.cooldown";
      at: string;
      provider: string;
      model: string;
      egressProxyEnvVar?: string;
      egressProxyHint?: string;
      cooldownSeconds?: number;
    }
  | {
      type: "autofix.applied";
      at: string;
      protocol: "openai" | "anthropic";
      provider: string;
      model: string;
    }
  | {
      type: "enforce.injected";
      at: string;
      guidanceLength: number;
      protocol: "openai" | "anthropic";
    }
  | {
      type: "enforce.attempt";
      at: string;
      attempt: number;
      maxRetries: number;
    }
  | {
      type: "enforce.validated";
      at: string;
      attempt: number;
      kind: "tool_calls" | "termination";
    }
  | {
      type: "enforce.empty_response";
      at: string;
      attempt: number;
      policy: "strict" | "lenient";
    }
  | {
      type: "enforce.retry";
      at: string;
      attempt: number;
      reason: string;
    }
  | {
      type: "enforce.stripped";
      at: string;
      contentBecameNull: boolean;
      toolCallsPreserved: boolean;
    }
  | {
      type: "stream.chunk";
      at: string;
      bytes: number;
      chunkNumber: number;
    }
  | {
      type: "request.finished";
      at: string;
      status: number;
      totalMs: number;
      errorType?: string;
      errorMessage?: string;
    };

export type RequestEventType = RequestEvent["type"];
