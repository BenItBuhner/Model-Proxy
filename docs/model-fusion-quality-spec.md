# Fusion Quality Evaluation Spec

## Objective
Push `fusion-beta` beyond plumbing correctness by measuring whether it produces diverse, terse, high-value advisory reasoning for difficult software-engineering and mathematics prompts while preserving the sealed-subagent contract and low resource usage.

## Requirements
- Exercise software-engineering and mathematics scenarios, including broad tool surfaces and multi-domain decomposition.
- Verify model diversity is available and used when subtasks request different model routings.
- Verify advisory outputs are not near-duplicates when different models are selected.
- Verify subagent advisory quality accounts for context coverage, not just short output shape.
- Emit a compact human-readable review of scorecard strengths and risks for quick triage.
- Include a negative-control benchmark fixture so the scorecard command proves it rejects shallow/broken Fusion traces.
- Report a compact benchmark gate with expected pass/fail counts and resource headroom.
- Keep subagent advisory handoff concise enough for the final fuser while preserving key recommendations.
- Preserve sealed subagents: no tools, `tool_choice: "none"`, no fake tool-call artifacts, and no claims of executed work.
- Preserve final-model authority over real tool use.
- Keep benchmarks offline, deterministic, and light on CPU/RAM so they do not interfere with other workloads.

## Scope
- Add a lightweight local evaluation harness under `tests/` or `benchmarks/` that uses mocked providers rather than live model calls.
- Add regression tests that cover task quality signals, model-route diversity, terse advisory packing, cache behavior, and SWE/math prompts.
- Add a deterministic scorecard and review summary that turn Fusion trace/prompt shape into reviewable SWE/math/diversity/context/terse-handoff metrics.
- Apply the scorecard to actual mocked Fusion gauntlet output, not only to a standalone fixture.
- Document findings and remaining limits in `docs/model-fusion-quality-scratchpad.md`.

## Out Of Scope
- Claiming actual GPT-5.5/Fable parity from local mocks.
- Running heavyweight public benchmark suites or live provider sweeps on this machine without an explicit resource plan.
- Giving subagents execution tools.

## Validation Plan
- Focused Fusion quality tests for software-engineering/math scenarios.
- Existing Fusion complex scenario tests.
- Full `bun test`, `bun run typecheck`, `bun run build`, and `git diff --check` before any commit.

## Definition Of Done
- [x] Quality scratchpad records the current review and test evidence.
- [x] Low-resource SWE/math evaluation coverage exists and passes.
- [x] Tests prove diverse subagent model routings are preserved through execution and synthesis metadata.
- [x] Tests prove advisory handoff remains terse and strips invalid action/tool-call artifacts.
- [x] Findings clearly state what local tests prove and what would still require live benchmark evaluation.
- [x] Scorecard evaluator reports measurable SWE/math/diversity/safety/terse-handoff scores.
- [x] Scorecard evaluator penalizes duplicated advisories and weak context coverage.
- [x] Scorecard benchmark emits compact pass/warn/fail review summaries.
- [x] Scorecard benchmark includes an expected-fail negative control.
- [x] Scorecard benchmark reports compact gate and resource-headroom fields.
- [x] Scorecard has a low-resource command and regression tests.
- [x] Scorecard is applied to the live mocked Fusion gauntlet output.
- [x] Scorecard command reports elapsed time and RSS delta budget checks across multiple hard-case fixtures.
