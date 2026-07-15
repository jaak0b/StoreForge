# Unit test review checklist

Apply to every new or changed test under `web/tests/**`, and to the suite when reviewing it.

1. **Read the assertion without the implementation open.** Can you tell what correct behavior it
   proves? If you have to open the module under test (or an unseen fixture) to understand the
   expectation, it is an obscure test.

2. **Would a plausible behavior-preserving refactor break it?** Renaming a private helper,
   reordering internal steps, or swapping an equivalent algorithm must not fail the test. If it
   would, the test is a change detector.

3. **Was the expected value derived independently?** Every expected literal must have a
   provenance outside the test: hand calculation, spec value, or the ground-truth seed of a
   synthetic render. Any formula, unit conversion, or production-helper call producing an
   expectation is a violation of the no-math hard rule.

4. **Grep for `toHaveBeenCalledWith`** (and `toHaveBeenCalled`, spy call-order asserts). Any
   occurrence that mirrors the calling code is interaction testing of a non-boundary; rewrite it
   to assert the resulting state.

5. **Snapshots: is the diff actually reviewed?** A snapshot whose updates get auto-accepted is a
   change detector. Prefer explicit literals for the fields that matter.

6. **Tolerances justified?** Each float band states or references why it is that size (noise
   floor, observed spread), is not a convenient round number, and was not widened to silence a
   failure. A band loose enough to pass with the wrong sign is worse than no test.

7. **Structure:** one behavior per test, the name states the behavior, arrange-act-assert
   visible, no conditional logic branching on outcomes, no shared mutable fixtures.

8. **For a bug-fix test: was it seen red?** Confirm it was run against the broken code (or the
   code temporarily re-broken) and failed for the intended reason.

9. **When in doubt, run Stryker on the touched module** (`npm run mutation` in `web/`, narrowing
   `mutate` to the module; see [mutation-testing.md](mutation-testing.md)). Surviving mutants on
   covered core code name the weak tests directly.

10. **Environmental failures are not leverage.** The real-scan fixture tests that fail on
    machines without the large fixtures never justify weakening, skipping, or tolerancing-away a
    test in committed code.
