# Banned test smells

Catalogue of the smells the unit tier bans, with the reasoning and what to do instead. Sources:
Meszaros's xUnit Test Patterns, the Google Testing Blog ("Testing on the Toilet" series), and
Khorikov's Unit Testing Principles.

## Tautological test

The expected value is produced by the same logic as the production code: calling a production
helper to build the expectation, re-implementing the formula inline, or converting units the same
way the code under test does. The test and the code share every bug and the test can only fail on
a typo. This is the smell behind the repo's hard rule: expected values are independent literals.

Fix: hardcode the expectation with a provenance outside the test (hand calculation, spec value,
or the seed parameters of a synthetic render).

## Change detector

A test that fails whenever the implementation changes, regardless of whether behavior changed:
asserting private call order, internal intermediate values, or committing large snapshots nobody
reads. Google's phrasing: change detectors are "worse than useless", because every refactor pays
a false-alarm tax and people learn to rubber-stamp expectation updates. If a snapshot exists, its
diff must actually be reviewed on every change; an auto-accepted snapshot is a change detector.

Fix: assert observable output through the public interface only.

## Over-mocking (interaction testing)

`expect(mock).toHaveBeenCalledWith(...)` that mirrors the calling code verifies "did I write the
code I wrote", not "is the result correct". Mocks are for true boundaries only: IO, network,
clock, randomness. This repo is deliberately classicist (Detroit style): engine tests inject a
real OpenCV.js instance (`tests/helpers/cv.ts`) and run on real or rendered fixtures. Do not
introduce mocks of engine stages or of `cv`.

Fix: call the real collaborators; assert the resulting state or return value.

## Obscure test / mystery guest

The reader cannot tell what correct behavior the test proves without opening the implementation
or an unseen shared fixture. Common forms: an expectation named `EXPECTED_RESULT` imported from
elsewhere, a fixture file whose relevant property is undocumented, setup buried in nested
`beforeEach` chains.

Fix: state the relevant fixture facts in the test (or its name), keep literals visible.

## Assertion roulette

Many asserts in one test with no labels: when one fails, nobody can tell which behavior broke.

Fix: one behavior per test; where several fields describe one outcome, keep them together but
make each assertion self-identifying (distinct matchers and values, or a message).

## Conditional logic in tests

`if`, `for`, or `try` branching on the outcome inside a test means the test itself needs testing,
and some branches never run. A data table of cases driving one straight-line body (Vitest
`test.each` or a loop that only *generates* tests) is fine: the logic generates cases, it does
not branch on results.

## Shared mutable fixtures

A module-level object mutated across tests couples them: order dependence, mysterious failures
when run in isolation. Prefer a local builder or factory function called inside each test.

## DRY over DAMP

Test code optimizes for verifiability by inspection, not for zero duplication. Duplicating three
lines of arrange code is better than a helper that hides which inputs matter. Extract helpers for
mechanics (loading a fixture, building a `cv` mat), never for meaning (the values being asserted).
