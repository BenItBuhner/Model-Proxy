# Fusion Quality Evaluation Spec

## Objective
Push `fusion-beta` beyond plumbing correctness by measuring whether it produces diverse, terse, high-value advisory reasoning for difficult software-engineering and mathematics prompts while preserving the sealed-subagent contract and low resource usage.

## Requirements
- Exercise software-engineering and mathematics scenarios, including broad tool surfaces and multi-domain decomposition.
- Verify model diversity is available and used when subtasks request different model routings.
- Keep subagent advisory handoff concise enough for the final fuser while preserving key recommendations.
- Preserve sealed subagents: no tools, `tool_choice: "none"`, no fake tool-call artifacts, and no claims of executed work.
- Preserve final-model authority over real tool use.
- Keep benchmarks offline, deterministic, and light on CPU/RAM so they do not interfere with other workloads.

## Scope
- Add a lightweight local evaluation harness under `tests/` or `benchmarks/` that uses mocked providers rather than live model calls.
- Add regression tests that cover task quality signals, model-route diversity, terse advisory packing, cache behavior, and SWE/math prompts.
- Add a deterministic scorecard that turns Fusion trace/prompt shape into reviewable SWE/math/diversity/terse-handoff metrics.
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
- [x] Scorecard has a low-resource command and regression tests.
