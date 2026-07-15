---
name: writing-unittests
description: Use when adding or changing a Vitest unit test under web/tests/**, when reviewing unit tests, or when a code change needs a unit test that would actually catch a real bug, before committing the change.
---

# Writing unit tests

The project has exactly two test tiers. Unit tests (Vitest, `web/tests/**`) are the internal
correctness net for whoever touches the code: they keep the engine math honest against synthetic
ground truth. Webtests (Playwright, `web/e2e/**`) are the owner-facing assurance that approved
feature output does not drift; they are governed by the sibling skill `writing-webtests` and
nothing here overrides it. This skill governs the unit tier only.

## The two questions every test must pass

A unit test earns its place by answering yes to both (Khorikov's four pillars, Beck's test
desiderata, the Google Testing Blog agree on the core):

1. **Would it fail on a real bug?** (regression protection)
2. **Would it stay green through a behavior-preserving refactor?** (refactoring resistance)

Plus fast feedback and maintainability. Test observable behavior through the public interface of
the module under test; never assert internal steps, private helpers, or call sequences. Test
state, not interactions: an interaction test checks how a result was reached, and only the result
matters. A test that fails both questions is a change detector, and a change detector is worse
than no test, because it trains people to update expectations on sight.

## HARD RULE: no math in tests

Owner-mandated and non-negotiable. An expected value is NEVER calculated inside a test: no
formulas, no unit conversions, no reuse of production helpers to derive the expectation. The
pipelines are deterministic, so every expected result is a hardcoded literal with an independent
provenance: hand-calculated once outside the test, taken from a spec or standard, or the known
ground truth a synthetic fixture was generated from. A test that recomputes the expected value
with the same formula as production is tautological: it shares any bug with the code under test
and can never catch the bug it mirrors (this exact failure shipped a sign-inversion bug once).

**Clarification, not an exception:** the render-recovery pattern
(`web/tests/helpers/paRender.ts`, `emRender.ts`, `isRender.ts`, and `TestData_2solid.png`)
generates the INPUT image from known parameters and asserts the pipeline recovers those hardcoded
parameters within tolerance. That is the gold-standard pattern in this repo, because the truth is
the seed literal, not a computed expectation. CLAUDE.md rule 1 makes these tests the gate on any
measurement-math change: they must stay green, unweakened.

Tolerances on float assertions come from the method's physical or numerical noise floor and are
justified where chosen, never a convenient round number, and never widened to make a failure pass.

## Banned smells

Full catalogue with examples in [references/smells.md](references/smells.md). The headline list
(Meszaros's xUnit Test Patterns, Google Testing Blog):

- **Tautological test**: expected value derived by the production formula (see hard rule above).
- **Change detector**: fails on any implementation change; unread snapshot dumps.
- **Over-mocking**: `expect(mock).toHaveBeenCalledWith(...)` mirroring the calling code tests
  "did I write this code". Mock only true boundaries (IO, network, clock). This repo injects a
  real `cv` instance and uses real fixtures (the classicist style); keep it that way.
- **Obscure test / mystery guest**: the expected behavior is unreadable without opening the
  implementation or an unseen shared fixture.
- **Assertion roulette**: many unlabeled asserts in one test.
- **Conditional logic in tests**: no if/loops branching on outcomes; parametrized case tables are
  fine.
- **Shared mutable fixtures**: prefer local builders per test.
- **DRY over DAMP**: duplication is acceptable when it keeps a test verifiable by inspection.

## Proving a test works

Details and recipes in [references/techniques.md](references/techniques.md).

- **Watch it fail first.** When writing a test for a bug, run it against the broken code (or
  temporarily re-break it) and see red. A test never seen red is unverified.
- **Mutation testing** is the mechanical version: `npm run mutation` in `web/` runs Stryker over
  the engine files changed against master. A surviving mutant on covered core code is direct
  evidence of a weak test. Never run `npm run mutation:full` on a dev machine: full-scope runs
  happen on CI only (manual workflow). Scope, targeted runs, and the local/CI split:
  [references/mutation-testing.md](references/mutation-testing.md).
- **Property-based tests** (fast-check) fit pure geometry and math stages: assert invariants over
  generated inputs.
- **Metamorphic tests** when no oracle exists: transform the input (rotate, mirror, scale) and
  assert the recovered measurement transforms consistently. The quarter-turn axis-leak tests in
  `emAnalyzer.spec.ts` are this pattern; keep and extend it.

## Structure rules

- One behavior per test; the name states the behavior ("returns aligned false when the marker is
  missing"), not the method name.
- Arrange-act-assert visibly separated.
- Expected literals visible in the test body, not hidden behind helpers or constants files.

## Review checklist

Use [references/review-checklist.md](references/review-checklist.md) when reviewing new or
existing unit tests.

## Environmental failures are not an excuse

A handful of real-scan fixture tests fail on machines that lack the large fixtures
(`cardGoldenScale`, `pa/realScan`, `em/realScan`, `backgroundPolarity`, the `cardEdgeMeasurer`
real-scan cases). That is a fixture-availability fact, never a reason to weaken an assertion,
widen a tolerance, or skip a test in committed code.
