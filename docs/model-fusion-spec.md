# Model Fusion (Beta) — Grind Mode Spec

## Objective
Implement the full 5-layer Model Fusion architecture in Model-Proxy-ts, enabling the proxy to orchestrate multiple LLM models in parallel, divide complex tasks among specialized subagents, and fuse their outputs into a single coherent response — all while streaming reasoning summaries to the client.

## Scope

### Included
- `shared/schemas/fusion.ts` — Fusion config Zod schema
- `src/routing/fusion/` — All fusion routing modules (fusion-router, complexity-scorer, task-divider, subagent-executor, response-fuser, reasoning-cache)
- `src/routing/fusion/context-search.ts` — Conversation context search for task division
- Integration with existing OpenAI and Anthropic route handlers
- Goalpost-triggered reasoning summary streaming (SSE)
- Config model `config/models/fusion-beta.json`
- Admin UI tab (`web/app/fusion/`)
- Full test suite in `tests/`

### Excluded (deferred)
- Subagent tool execution surfaces. Subagents are sealed reasoning-only workers; final tool/action behavior remains outside subagent execution.
- Production Docker image changes beyond the base config

## Constraints & Requirements
- Must not break existing model routings (complete, turbo, glm-5.2, etc.)
- Must reuse existing infrastructure: provider registry, format converters, API key manager, event system
- Fusion config references existing model routings — does NOT define new provider/route info
- All models are free/unlimited — no cost guardrails needed
- First fusion logical model: `fusion-beta`
- Output supports both OpenAI and Anthropic wire protocols
- Subagent errors never cascade — retry exhaustively, produce empty/null on complete failure

## Implementation Order
1. Config schema + model loader support
2. FusionRouter shell
3. ComplexityScorer
4. TaskDividerAgent
5. SubagentExecutor
6. ResponseFuser
7. ReasoningCache
8. Subagent hardening and adaptive context packing
9. Goalpost streaming
10. Admin UI
11. Anthropic wire protocol support
12. Edge cases + hardening

## Validation Plan
- **Unit tests:** Each fusion module in isolation
- **Integration tests:** FusionRouter orchestrating subagent executor + response fuser with mock providers
- **Wire protocol tests:** Fusion output correct in both OpenAI and Anthropic formats
- **Streaming tests:** SSE events emitted correctly with goalpost summaries
- **Regression tests:** Existing router tests still pass
- **Manual test:** Deploy fusion-beta model config, send chat request, verify multi-model orchestration

## Definition of Done
- [x] Plan saved to `docs/model-fusion-plan.md`
- [ ] Step 1: Fusion config schema created, exported, integrated into ModelRoutingConfig
- [ ] Step 2: FusionRouter shell dispatches Effort 1 to FallbackRouter
- [ ] Step 3: ComplexityScorer correctly ranks tasks
- [ ] Step 4: TaskDividerAgent uses tool-calling to divide tasks
- [ ] Step 5: SubagentExecutor runs parallel reasoning-only subagents referencing existing model routings, with no tools or execution surface
- [ ] Step 6: ResponseFuser appends sequentially and feeds fusion model
- [ ] Step 7: ReasoningCache stores/retrieves subagent outputs permanently
- [ ] Step 8: Subagent tool/sandbox backend removed; context is pre-packed by the proxy
- [ ] Step 9: Goalpost-triggered SSE streaming works
- [ ] Step 10: Admin UI Fusion tab visible
- [x] Step 11: Both OpenAI and Anthropic wire protocols supported
- [ ] Step 12: Edge cases handled, all tests pass
- [ ] End-to-end: `fusion-beta` model responds to chat completions
