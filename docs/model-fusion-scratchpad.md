# Model Fusion (Beta) — Scratchpad

## Current Focus
Continue hardening Fusion toward production-grade reasoning quality: sealed subagents, adaptive route-sized context packs over the 10M logical window, coherent synthesis handoff, cache/summary correctness, and richer live/completed observability.

## To-Dos (current hardening order)
- [x] Audit whether cached legacy subagent outputs can reintroduce action/tool-call claims into summaries, traces, or fuser handoff.
- [x] Normalize deprecated effort-level subagent `tools` config to `[]` at parse time so legacy config cannot carry a tool surface forward.
- [ ] Add another complex scenario/backtest that exercises ambiguous tool-heavy turns with cache reuse and synthesis quality guardrails.
- [ ] Continue improving live/completed observability where trace detail exists but the dashboard does not surface it clearly.
- [ ] Run full validation after every scoped change: `bun test`, `bun run typecheck`, relevant web checks, builds, and `git diff --check`.
- [ ] Perform a requirement-by-requirement completion audit before marking the Fusion goal complete.

## Completed
- [x] **Step 1:** `shared/schemas/fusion.ts` — FusionConfig schema with all layers (complexity scoring, task divider, effort levels, fusion synthesis, cache)
- [x] **Step 2:** `src/routing/fusion/fusion-router.ts` — full orchestrator with cache lookup → complexity scoring → task division → subagent execution → response fusion
- [x] **Step 3:** `src/routing/fusion/complexity-scorer.ts` — 8-dimension heuristic scoring (token count, tools, turns, code, reasoning, context, multi-turn)
- [x] **Step 4:** `src/routing/fusion/task-divider.ts` — tool-calling agent using GLM-5.2 with search_context + divide_task tools
- [x] **Step 5:** `src/routing/fusion/subagent-executor.ts` — parallel reasoning-only subagent execution with no tools, adaptive context packing, retry, and concurrency limits
- [x] **Step 6:** `src/routing/fusion/response-fuser.ts` — sequential append + fusion model synthesis (streaming + non-streaming)
- [x] **Step 7:** `src/routing/fusion/reasoning-cache.ts` — permanent on-disk cache with SHA-256 keying, full CRUD
- [x] **Step 8:** Subagent tool/sandbox backend removed — subagents now receive no tools or execution surface
- [x] **Step 9:** `src/routing/fusion/types.ts` — all Fusion types/interfaces
- [x] **Integration:** FusionRouter dispatch wired into `src/server/routes/openai.ts` — streaming + non-streaming
- [x] **Config:** `config/models/fusion-beta.json` — complete fusion model config
- [x] **Tests:** 230 tests total (6 fusion-specific, 4 schema validation, 4 router, 7 cache, 209 existing)
- [x] **Regressions:** 0 — all 230 tests pass with no failures
- [x] **Subagent tool hardening:** subagent requests omit tools and set `tool_choice: "none"`; hallucinated tool-call-only output is retried and inline tool-call artifacts are stripped before summaries/synthesis.
- [x] **Deprecated tool config removal:** legacy `effort_levels.2.tools` and `effort_levels.3.tools` inputs are accepted for compatibility but normalized to empty arrays by the Fusion schema.
- [x] **Adaptive context packs:** subagents pack first/relevant/anchor/recent conversation slices against each selected route context window while preserving Fusion's 10M logical context telemetry.
- [x] **Context-pack persistence:** fresh and cache-reused subagent runs persist context pack metadata; cached reuse emits completed live lanes.
- [x] **Synthesis handoff:** subagent findings are converted to bounded advisory records with tool-call artifact stripping and final-model instructions not to echo internal labels.
- [x] **Observability:** live/completed Fusion dashboard shows decision triggers/suppressors, context-pack coverage, logical vs route budgets, selected ranges, summary feed, cache reuse, and reconstructed historical traces.

## Deferred / Future Work
- [ ] **Admin UI tab** (`web/app/fusion/`) — needs Next.js UI components
- [ ] **Anthropic wire protocol integration** — handler in `anthropic.ts` for fusion dispatch
- [x] **Goalpost streaming via SSE** — real-time reasoning summaries flowing to client during subagent execution
- [ ] **Integration tests** for full pipeline (task-divider → subagent-executor → response-fuser with real providers)

## Blockers (none)
None yet

## Findings / Decisions
- Subagents are sealed reasoning-only workers; the proxy pre-packs context and the final fusion model performs any real tool calls/actions.
- All subagent model references point to existing model routings (complete, turbo, glm-5.2, etc.)

## Test Results
- 2026-07-09: `bun test` passed, 354 tests.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `cd web && bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `bun run build:web` passed.
- 2026-07-09: `git diff --check` passed.
- 2026-07-09: Focused `bun test tests/fusion-schema.test.ts tests/fusion-subagent-tools.test.ts tests/fusion-complex-scenarios.test.ts` passed, 22 tests.
