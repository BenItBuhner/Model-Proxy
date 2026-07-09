# Model Fusion (Beta) — Finalized Implementation Plan

## Status: **Approved — Ready for Implementation**

---

## 1. Subagent Execution Surface

**Decision: reasoning-only sealed subagents**

Fusion subagents are advisory model calls, not execution workers. They receive no tools, no function schemas, and no filesystem, network, terminal, or git access. The proxy pre-packs the relevant conversation context for each subagent according to the selected model route's actual context window, while preserving Fusion's logical 10M-token context claim at the orchestration layer.

**Implementation:**
- Subagent requests set `tool_choice: "none"` and omit tool definitions.
- The subagent system prompt explicitly states that the environment is sealed and that tool-call syntax is invalid.
- The proxy builds a stratified context packet from opening messages, relevant matches, middle anchors, and recent messages.
- Each packet is bounded by the resolved model route context window and reserves output budget for the subagent's answer.
- Empty, invalid, and tool-call-only outputs are retried until retries are exhausted.
- Failed subagents do not cascade into request failure, and incomplete subagent result sets are not cached.

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
       │    ├─ Subagents receive no tools and no function schemas (`tool_choice: "none"`)
       │    ├─ The proxy pre-packs a stratified, model-budgeted context packet
       │    ├─ SSE streaming: live reasoning summaries to client
       │    └─ Error handling: retry invalid/empty/tool-call-only output until exhausted
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
├── context-search.ts         # Conversation context search for task division
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
      tools: z.array(z.enum(["context_search", "web_search"])).optional(), // deprecated; accepted then normalized to []
    }),
    3: z.object({
      subagent_count: z.object({
        min: z.number().int().min(1).default(4),
        max: z.number().int().min(1).default(8),
      }),
      model_routings: z.array(z.string()).min(1),
      tools: z.array(z.enum(["context_search", "web_search", "code_execution"])).optional(), // deprecated; accepted then normalized to []
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
| **Subagent reasoning segment** | Summarize what the subagent is analyzing |
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
| **Subagent tools** | None. Subagents are sealed reasoning-only workers; task divider/fuser are the only tool-capable model calls. |
| **Cost guardrails** | Not needed — all models are free/unlimited |
| **Streaming UX** | Goalpost-triggered reasoning summaries streamed via SSE during subagent work |
| **Error semantics** | Retry invalid/empty/tool-call-only subagent output; failed subagents do not cascade and incomplete result sets are not cached |
| **Fusion vs standalone routing** | Fusion references existing model routings — inherits full reliability pipeline |
| **Task divider model** | GLM-5.2 default, tool-calling to divide, searches full context unfiltered |
| **Effort 1 context exception** | Auto-escalate to Effort 2 when context window exceeded |
| **Cache scoping** | Permanent successful subagent output sets saved, reconstructable on cache hit |
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
8. **Subagent hardening** — reasoning-only sealed subagents, adaptive context packing, retry handling
9. **Goalpost streaming** — SSE reasoning traces during subagent execution
10. **Admin UI** — Fusion tab in web app
11. **Anthropic wire protocol support** — Guarantee fusion output works with Anthropic SDKs
12. **Edge cases + hardening** — Timeout cascades, partial failures, cache invalidation
