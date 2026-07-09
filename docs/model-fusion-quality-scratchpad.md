# Fusion Quality Evaluation Scratchpad

## Current Focus
Build a low-resource quality gauntlet for Fusion that stresses software-engineering/math decomposition, model diversity, terse advisory handoff, sealed subagents, and final-model tool authority.

## To-Dos
- [x] Inspect current model diversity and handoff behavior.
- [x] Add offline SWE/math quality regression coverage.
- [x] Add or document a lightweight benchmark/eval entrypoint.
- [x] Run focused and full validation.
- [x] Record review findings and remaining live-benchmark limits.

## Findings
- `fusion-beta` already exposes a diverse candidate pool for Effort 2/3: GLM, Kimi code, MiniMax, DeepSeek, Mimo, and Nemotron routes.
- Existing tests prove sealed subagents and cache reuse, but do not yet score whether the subtask plan is balanced across SWE/math reasoning styles.
- The first quality gauntlet exposed a real scoring gap: a TypeScript scheduler + mathematical proof prompt with many tools initially resolved to Effort 2, which capped subagents at 3 and prevented the precision math route from being used.
- `src/routing/fusion/complexity-scorer.ts` now recognizes common SWE/math quality signals such as TypeScript, scheduler, queue, invariant, correctness, starvation, bounded wait, ranking function, and counterexample.
- The gauntlet now proves the same prompt resolves to Effort 3, preserves four distinct divider-selected model routings, keeps all subagent requests sealed, strips invalid action/tool-call artifacts, and hands the fuser a concise advisory prompt.
- `bun run eval:fusion-quality` runs the low-resource focused evaluator without live provider calls or heavyweight benchmark builds.
- The older complex-scenario fixture now pins its local Effort 3 minimum to 2 so it continues testing two-subtask cache reuse instead of accidentally testing policy-fill behavior.
- Local mocked evals prove routing, isolation, diversity preservation, and prompt-shape invariants. They do not prove real-world GPT-5.5/Fable parity; that would require a live benchmark pass with explicit provider, rate, cost, and resource limits.

## Test Results
- 2026-07-09: `bun test tests/fusion-complexity-scorer.test.ts tests/fusion-quality-gauntlet.test.ts` passed, 8 tests / 59 assertions.
- 2026-07-09: `bun run eval:fusion-quality` passed, 8 tests / 59 assertions.
- 2026-07-09: `bun test tests/fusion-complex-scenarios.test.ts` passed, 4 tests / 136 assertions.
- 2026-07-09: `bun test tests/multi-user-auth.test.ts` passed, 4 tests / 22 assertions after a transient full-suite timeout.
- 2026-07-09: `bun test` passed, 358 tests / 1409 assertions.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `git diff --check` passed.
