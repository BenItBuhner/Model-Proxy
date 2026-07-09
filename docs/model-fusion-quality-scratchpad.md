# Fusion Quality Evaluation Scratchpad

## Current Focus
Harden the deterministic scorecard against shallow diversity by scoring advisory uniqueness and context coverage.

## To-Dos
- [x] Inspect current model diversity and handoff behavior.
- [x] Add offline SWE/math quality regression coverage.
- [x] Add or document a lightweight benchmark/eval entrypoint.
- [x] Run focused and full validation.
- [x] Record review findings and remaining live-benchmark limits.
- [x] Add deterministic Fusion quality scorecard.
- [x] Add scorecard command and tests.
- [x] Re-run focused/full validation after scorecard work.
- [x] Apply scorecard assertions to the actual mocked Fusion gauntlet output.
- [x] Add elapsed time and RSS delta budget reporting to the scorecard command.
- [x] Add advisory-diversity and context-coverage scorecard dimensions.
- [x] Add regression coverage for duplicated advisories with varied model labels.

## Findings
- `fusion-beta` already exposes a diverse candidate pool for Effort 2/3: GLM, Kimi code, MiniMax, DeepSeek, Mimo, and Nemotron routes.
- Existing tests prove sealed subagents and cache reuse, but do not yet score whether the subtask plan is balanced across SWE/math reasoning styles.
- The first quality gauntlet exposed a real scoring gap: a TypeScript scheduler + mathematical proof prompt with many tools initially resolved to Effort 2, which capped subagents at 3 and prevented the precision math route from being used.
- `src/routing/fusion/complexity-scorer.ts` now recognizes common SWE/math quality signals such as TypeScript, scheduler, queue, invariant, correctness, starvation, bounded wait, ranking function, and counterexample.
- The gauntlet now proves the same prompt resolves to Effort 3, preserves four distinct divider-selected model routings, keeps all subagent requests sealed, strips invalid action/tool-call artifacts, and hands the fuser a concise advisory prompt.
- `bun run eval:fusion-quality` runs the low-resource focused evaluator without live provider calls or heavyweight benchmark builds.
- The older complex-scenario fixture now pins its local Effort 3 minimum to 2 so it continues testing two-subtask cache reuse instead of accidentally testing policy-fill behavior.
- Local mocked evals prove routing, isolation, diversity preservation, and prompt-shape invariants. They do not prove real-world GPT-5.5/Fable parity; that would require a live benchmark pass with explicit provider, rate, cost, and resource limits.
- `src/routing/fusion/quality-scorecard.ts` adds a deterministic scorecard over domain coverage, model diversity, terse handoff, safety, and final-tool authority.
- `bun run eval:fusion-scorecard` emits JSON suitable for quick review without live model calls; current fixture scored overall 1.0 with 596 prompt chars, max 97 advisory chars, four domains, four unique models, and no failed checks.
- The live mocked gauntlet output now feeds the same scorecard and asserts overall >= 0.95 plus perfect domain coverage, model diversity, terse handoff, safety, final-tool authority, and no failed checks.
- The scorecard benchmark now runs three deterministic hard-case fixtures: TypeScript scheduler proof/rollout, Rust async backpressure proof, and symbolic math kernel correctness.
- The latest scorecard suite run scored minOverall 1.0 / averageOverall 1.0 with no failed cases, completing in 3.71 ms with 1.88 MB RSS delta against limits of 1000 ms and 64 MB.
- The scorecard now includes advisoryDiversity via pairwise token-overlap checks and contextCoverage via advisory context coverage percentages.
- A focused regression proved that varied model labels are not enough: duplicated generic advisories with 25% average context coverage now fail with advisory similarity and context coverage checks.

## Test Results
- 2026-07-09: `bun test tests/fusion-complexity-scorer.test.ts tests/fusion-quality-gauntlet.test.ts` passed, 8 tests / 59 assertions.
- 2026-07-09: `bun run eval:fusion-quality` passed, 8 tests / 59 assertions.
- 2026-07-09: `bun test tests/fusion-complex-scenarios.test.ts` passed, 4 tests / 136 assertions.
- 2026-07-09: `bun test tests/multi-user-auth.test.ts` passed, 4 tests / 22 assertions after a transient full-suite timeout.
- 2026-07-09: `bun test` passed, 358 tests / 1409 assertions.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `git diff --check` passed.
- 2026-07-09: `bun test tests/fusion-quality-scorecard.test.ts tests/fusion-quality-gauntlet.test.ts` passed, 4 tests / 72 assertions after adding advisoryDiversity and contextCoverage.
- 2026-07-09: `bun run eval:fusion-scorecard` passed 3 cases with minOverall 1.0, averageOverall 1.0, elapsedMs 9.03, and rssDeltaMb 3.
- 2026-07-09: `bun run eval:fusion-scorecard` passed 3 cases with minOverall 1.0, averageOverall 1.0, elapsedMs 12.28, and rssDeltaMb 2.25 after docs updates.
- 2026-07-09: `bun run eval:fusion-quality` passed, 11 tests / 88 assertions after advisory-diversity/context-coverage scoring.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `git diff --check` passed.
- 2026-07-09: Full `bun test` attempt hit two recurring unrelated `multi-user auth` timeouts after 359 passes; isolated `bun test tests/multi-user-auth.test.ts` passed, 4 tests / 22 assertions.
- 2026-07-09: Expanded `bun run eval:fusion-scorecard` suite passed 3 cases with minOverall 1.0, averageOverall 1.0, elapsedMs 3.71, and rssDeltaMb 1.88.
- 2026-07-09: `bun run eval:fusion-quality` passed, 10 tests / 78 assertions after expanding the scorecard suite.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `git diff --check` passed.
- 2026-07-09: `bun test tests/fusion-quality-scorecard.test.ts` passed, 2 tests / 12 assertions.
- 2026-07-09: `bun run eval:fusion-scorecard` passed with overall/domain/diversity/terse/safety/final-tool scores all 1.0.
- 2026-07-09: `bun run eval:fusion-quality` passed, 10 tests / 71 assertions after adding scorecard coverage.
- 2026-07-09: `bun test tests/fusion-quality-gauntlet.test.ts tests/fusion-quality-scorecard.test.ts` passed, 3 tests / 62 assertions with live gauntlet scorecard assertions.
- 2026-07-09: `bun run eval:fusion-scorecard` passed with elapsedMs 5.06 and rssDeltaMb 1.63.
- 2026-07-09: `bun run eval:fusion-quality` passed, 10 tests / 78 assertions after live gauntlet scorecard terse-handoff coverage.
- 2026-07-09: First full `bun test` rerun had two unrelated `multi-user auth` timeouts after 358 passes; isolated `bun test tests/multi-user-auth.test.ts` then passed, 4 tests / 22 assertions.
- 2026-07-09: Second full `bun test` passed, 360 tests / 1428 assertions.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `git diff --check` passed.
- 2026-07-09: `bun test` passed, 360 tests / 1421 assertions.
- 2026-07-09: `bun run typecheck` passed.
- 2026-07-09: `bun run build` passed.
- 2026-07-09: `git diff --check` passed.
