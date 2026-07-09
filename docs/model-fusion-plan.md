# Model Fusion (Beta) — Finalized Implementation Plan

## Status: **Approved — Ready for Implementation**

---

## 1. Code Execution Sandbox

**Decision: WASM-based sandbox via `wasmtime`**

Given the Docker deployment and the need for controlled network access, WASM provides the best balance of security and practicality:

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Subprocess + seccomp | Simple, fast | Coarse isolation, large syscall surface | Too risky |
| Docker-in-Docker | Strong isolation | High overhead per subagent, slow startup | Overkill |
| **WASM sandbox** | **Fine-grained capability control, fast startup, cross-platform, fuel metering** | Requires WASM-compiled runtimes for Python/JS | **Selected** |

**Implementation:**
- Runtime: `wasmtime` SDK via Bun (child process or embedded via FFI)
- **Python:** Use Pyodide (CPython compiled to WASM) — supports `numpy`, `requests`, standard library
- **JavaScript/TypeScript:** Use `quickjs-wasm` or Bun's own `Bun.spawn` for JS-only (V8/JavaScriptCore is inherently sandboxed)
- **Network:** Provide a `fetch` shim in the WASM runtime that routes through Model-Proxy's own `upstream-fetch.ts` with:
  - Allow-list of allowed domains (default: any HTTPS)
  - Timeout enforcement
  - Bandwidth limits
  - Logging via existing observability system
- **Filesystem:** In-memory virtual FS only (no host filesystem access)
- **CPU/Memory:** WASM fuel metering (gas) + runtime memory limits
- **Storage:** Code execution outputs captured inline — no persistent FS

---

## 2. Architecture & Request Flow

```
Client POST /v1/chat/completions { model: "fusion-beta", messages: [...] }
  │
  ├─ Auth middleware (unchanged)
  ├─ Parse request body (unchanged)
  ├─ Load model config → detects `fusion: { ... }` block
  │
  └─ FusionRouter.handle(request, fusionConfig)
       │
       ├─ [Layer 1] Check reasoning cache
       │    └─ Cache hit? → reconstruct subagent outputs, skip to fusion
       │
       ├─ [Layer 2] ComplexityScorer.score(request)
       │    ├─ Effort 1 → FallbackRouter (standard single-model path)
       │    │   └─ Exception: if base model's context_window is exceeded
       │    │       → auto-escalate to Effort 2
       │    ├─ Effort 2 → moderate parallelism (2-4 subagents)
       │    └─ Effort 3 → full parallelism (4-8+ subagents)
       │
       ├─ [Layer 3] TaskDividerAgent.divide(request, effort)
       │    ├─ Model: GLM-5.2 (default, configurable)
       │    ├─ Tools: search_context, list_model_routings, divide_task
       │    └─ Output: sub-task definitions referencing existing model routings
       │
       ├─ [Layer 4] SubagentExecutor.execute(subtasks, effort)
       │    ├─ Spawns N parallel subagents (via adapted HedgedRouter infrastructure)
       │    ├─ Each subagent uses an existing model routing (complete, turbo, etc.)
       │    ├─ Each subagent gets tools: context_search, web_search, code_execution
       │    ├─ SSE streaming: goalpost-triggered reasoning summaries to client
       │    └─ Error handling: retry "via any means" until success or exhausted
       │
       ├─ [Layer 5] ResponseFuser.fuse(subagentOutputs, originalRequest)
       │    ├─ Append all subagent outputs sequentially (NOT merged/interleaved)
       │    ├─ Feed appended content + original request to fusion model
       │    └─ Fusion model streams reasoning + final response
       │
       └─ Return final response via OpenAI or Anthropic wire protocol
```

---

## 3. New Files & Modules

```
src/routing/fusion/
├── fusion-router.ts          # Top-level orchestrator, dispatches to layers
├── complexity-scorer.ts      # Layer 2: analyze task → effort 1/2/3
├── task-divider.ts           # Layer 3: agentic task division via tool-calling
├── subagent-executor.ts      # Layer 4: parallel subagent execution
├── response-fuser.ts         # Layer 5: sequential append + synthesis
├── reasoning-cache.ts        # Layer 1: permanent fusion cache
├── sandbox/
│   ├── wasm-executor.ts      # Code execution sandbox (Pyodide/quickjs-wasm)
│   ├── wasm-runtime.ts       # WASM runtime lifecycle management
│   ├── fetch-shim.ts         # Controlled network proxy for WASM
│   └── types.ts
└── types.ts                  # Fusion-specific types/interfaces

shared/schemas/
├── fusion.ts                 # NEW — FusionConfig, ComplexityScoringConfig, etc.
└── index.ts                  # +export fusion schema

web/app/fusion/               # NEW — Admin UI tab
├── page.tsx                  # Fusion overview/status
├── cache.tsx                 # Cache browser/invalidator
└── subagents.tsx             # Live subagent monitoring

tests/
├── fusion-router.test.ts
├── complexity-scorer.test.ts
├── task-divider.test.ts
├── subagent-executor.test.ts
├── response-fuser.test.ts
├── reasoning-cache.test.ts
└── sandbox/
    └── wasm-executor.test.ts
```

---

## 4. Config Schema (Final)

Extended into `ModelRoutingConfig` as an optional `fusion` block:

```typescript
// shared/schemas/fusion.ts
export const FusionConfigSchema = z.object({
  enabled: z.boolean(),

  // Context window claim (default 10M tokens)
  context_window: z.number().int().positive().default(10_000_000),

  // Layer 2: Complexity thresholds
  complexity_scoring: z.object({
    effort_1_threshold: z.number().min(0).max(1).default(0.3),
    effort_2_threshold: z.number().min(0).max(1).default(0.7),
  }),

  // Layer 3: Task divider
  task_divider: z.object({
    model_routing: z.string().default("glm-5.2"),
    timeout_seconds: z.number().int().positive().default(60),
    max_subtasks: z.number().int().min(1).max(50).default(10),
  }),

  // Layer 4: Subagent pools
  effort_levels: z.object({
    1: z.object({
      model_routing: z.string(),
    }),
    2: z.object({
      subagent_count: z.object({
        min: z.number().int().min(1).default(2),
        max: z.number().int().min(1).default(4),
      }),
      model_routings: z.array(z.string()).min(1),
      tools: z.array(z.enum(["context_search", "web_search"])).default(["context_search"]),
    }),
    3: z.object({
      subagent_count: z.object({
        min: z.number().int().min(1).default(4),
        max: z.number().int().min(1).default(8),
      }),
      model_routings: z.array(z.string()).min(1),
      tools: z.array(z.enum(["context_search", "web_search", "code_execution"])),
    }),
  }),

  // Layer 5: Fusion synthesis
  fusion: z.object({
    model_routing: z.string(),
    strategy: z.literal("sequential_append").default("sequential_append"),
    wire_protocol: z.enum(["openai", "anthropic"]).default("openai"),
  }),

  // Layer 1: Cache
  cache: z.object({
    enabled: z.boolean().default(true),
    scope: z.literal("permanent").default("permanent"),
  }),
});
```

Extension in `routing.ts`:
```typescript
// Add to ModelRoutingConfigSchema:
fusion: FusionConfigSchema.optional(),
```

---

## 5. Goalpost Tracking (Layer 1 Streaming)

Goalposts are **key events in subagent reasoning traces** that trigger summarization streaming to the client:

| Event Type | Triggers Summary |
|---|---|
| **Tool call** (any) | Summarize what the tool did and its result |
| **Assistant response** (key content produced) | Summarize what the subagent concluded |
| **Task division complete** | Summarize how tasks were divided |
| **Subagent complete** | Summarize subagent's findings |
| **Final synthesis begins** | Signal that fusion model is now reasoning |

The summarizing model (configurable, defaults to `turbo`) receives a portion of the transcript around the goalpost and produces a concise summary streamed as SSE `data: {"type":"reasoning","summary":"..."}`.

---

## 6. Integration Points (Existing Files to Modify)

| File | What Changes |
|---|---|
| `shared/schemas/routing.ts` | Add optional `fusion?: FusionConfig` to `ModelRoutingConfigSchema` |
| `shared/schemas/index.ts` | Re-export FusionConfigSchema |
| `src/server/routes/openai.ts` | In `handleChatCompletions`, check for fusion config → route to FusionRouter |
| `src/server/routes/anthropic.ts` | Same — fusion output via Anthropic wire protocol |
| `src/routing/fallback.ts` | May refactor `collectRouteConfigs` for reuse by subagent execution |
| `src/observability/event-sink.ts` | Add fusion-specific event types (subagent_start, subagent_complete, etc.) |
| `src/storage/completion-store.ts` | Add fusion cache namespace, get/put methods |
| `src/config/model-loader.ts` | No changes needed — fusion is a subfield of existing model configs |
| `web/app/` | Add `/fusion` route, nav entry in app-shell, fusion page components |

---

## 7. Decisions Summary

| Question | Decision |
|---|---|
| **Code execution sandbox** | WASM via `wasmtime` (Pyodide for Python, quickjs-wasm for JS/TS), controlled network via fetch shim |
| **Cost guardrails** | Not needed — all models are free/unlimited |
| **Streaming UX** | Goalpost-triggered reasoning summaries streamed via SSE during subagent work |
| **Error semantics** | Retry "via any means" — subagent failures never cascade, just produce empty/null |
| **Fusion vs standalone routing** | Fusion references existing model routings — inherits full reliability pipeline |
| **Task divider model** | GLM-5.2 default, tool-calling to divide, searches full context unfiltered |
| **Effort 1 context exception** | Auto-escalate to Effort 2 when context window exceeded |
| **Cache scoping** | Permanent, full subagent outputs saved, reconstructable on cache hit |
| **Effort 2 vs 3 granularity** | More subagents, greater division effort, enforced verbosity/terseness |
| **Fusion response strategy** | Sequential append (no merge), then fusion model streams reasoning + response |
| **Anthropic wire protocol** | Supported — fusion output can emit OpenAI or Anthropic format |
| **First fusion model name** | `fusion-beta` |
| **Admin UI** | New "Fusion" tab in admin UI with subagent monitoring and cache management |

---

## 8. Implementation Order

1. **Config schema + model loader support** — `shared/schemas/fusion.ts`, extend routing schema
2. **FusionRouter shell** — `fusion-router.ts`, minimal orchestrator that delegates to existing FallbackRouter for Effort 1
3. **ComplexityScorer** — `complexity-scorer.ts`, token counting + heuristics
4. **TaskDividerAgent** — `task-divider.ts`, tool-calling with GLM-5.2
5. **SubagentExecutor** — `subagent-executor.ts`, adapted from HedgedRouter parallel patterns
6. **ResponseFuser** — `response-fuser.ts`, sequential append + final model synthesis
7. **ReasoningCache** — `reasoning-cache.ts`, permanent cache with hit detection
8. **WASM sandbox** — `sandbox/wasm-executor.ts`, Pyodide + quickjs-wasm integration
9. **Goalpost streaming** — SSE reasoning traces during subagent execution
10. **Admin UI** — Fusion tab in web app
11. **Anthropic wire protocol support** — Guarantee fusion output works with Anthropic SDKs
12. **Edge cases + hardening** — Timeout cascades, partial failures, cache invalidation
