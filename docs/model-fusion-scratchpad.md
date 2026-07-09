# Model Fusion (Beta) — Scratchpad

## Current Focus
Step 1: Create FusionConfig schema (shared/schemas/fusion.ts) and integrate into ModelRoutingConfig

## To-Dos (by implementation order)
- [x] Write finalized plan to docs/model-fusion-plan.md
- [ ] Step 1: Create `shared/schemas/fusion.ts`, export from index.ts, add to routing.ts
- [ ] Step 2: Create `src/routing/fusion/fusion-router.ts` — orchestrator shell
- [ ] Step 3: Create `src/routing/fusion/complexity-scorer.ts`
- [ ] Step 4: Create `src/routing/fusion/task-divider.ts`
- [ ] Step 5: Create `src/routing/fusion/subagent-executor.ts`
- [ ] Step 6: Create `src/routing/fusion/response-fuser.ts`
- [ ] Step 7: Create `src/routing/fusion/reasoning-cache.ts`
- [ ] Step 8: Create `src/routing/fusion/sandbox/` (wasm-executor, wasm-runtime, fetch-shim, types)
- [ ] Step 9: Integrate goalpost streaming into fusion-router
- [ ] Step 10: Create `web/app/fusion/` admin UI pages
- [ ] Step 11: Anthropic wire protocol support for fusion output
- [ ] Step 12: Edge cases, hardening, test creation
- [ ] Create `config/models/fusion-beta.json`
- [ ] All tests pass
- [ ] End-to-end verification

## Completed
- [x] **Step 1:** `shared/schemas/fusion.ts` — FusionConfig schema with all layers (complexity scoring, task divider, effort levels, fusion synthesis, cache)
- [x] **Step 2:** `src/routing/fusion/fusion-router.ts` — full orchestrator with cache lookup → complexity scoring → task division → subagent execution → response fusion
- [x] **Step 3:** `src/routing/fusion/complexity-scorer.ts` — 8-dimension heuristic scoring (token count, tools, turns, code, reasoning, context, multi-turn)
- [x] **Step 4:** `src/routing/fusion/task-divider.ts` — tool-calling agent using GLM-5.2 with search_context + divide_task tools
- [x] **Step 5:** `src/routing/fusion/subagent-executor.ts` — parallel subagent execution with retry, goalpost detection, concurrency limits
- [x] **Step 6:** `src/routing/fusion/response-fuser.ts` — sequential append + fusion model synthesis (streaming + non-streaming)
- [x] **Step 7:** `src/routing/fusion/reasoning-cache.ts` — permanent on-disk cache with SHA-256 keying, full CRUD
- [x] **Step 8:** `src/routing/fusion/sandbox/` — WASM sandbox stub (Bun subprocess), fetch shim with domain allow-listing
- [x] **Step 9:** `src/routing/fusion/types.ts` — all Fusion types/interfaces
- [x] **Integration:** FusionRouter dispatch wired into `src/server/routes/openai.ts` — streaming + non-streaming
- [x] **Config:** `config/models/fusion-beta.json` — complete fusion model config
- [x] **Tests:** 230 tests total (6 fusion-specific, 4 schema validation, 4 router, 7 cache, 209 existing)
- [x] **Regressions:** 0 — all 230 tests pass with no failures

## Deferred / Future Work
- [ ] **Admin UI tab** (`web/app/fusion/`) — needs Next.js UI components
- [ ] **Anthropic wire protocol integration** — handler in `anthropic.ts` for fusion dispatch
- [ ] **WASM runtime swap** — replace Bun subprocess stub with real wasmtime/Pyodide
- [ ] **Goalpost streaming via SSE** — real-time reasoning summaries flowing to client during subagent execution
- [ ] **Integration tests** for full pipeline (task-divider → subagent-executor → response-fuser with real providers)

## Blockers (none)
None yet

## Findings / Decisions
- WASM sandbox will be stubbed with Bun subprocess execution initially (same API surface, trivially swappable)
- All subagent model references point to existing model routings (complete, turbo, glm-5.2, etc.)

## Test Results
(not yet)
