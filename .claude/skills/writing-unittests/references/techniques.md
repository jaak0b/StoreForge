# Techniques for proving a test works

A test is a claim ("this would catch that bug"). Each technique below is a way to check the
claim instead of assuming it.

## Watch it fail first

The cheapest proof. When writing a test for a bug, run the test against the broken code before
fixing it and confirm it goes red for the expected reason (read the failure message: a timeout or
an import error is not the failure you meant). When writing a test for existing correct code,
temporarily re-break the code (flip a sign, off-by-one a bound) and confirm the test catches it,
then revert. A test that has never been seen red is unverified; it may be asserting nothing.

## Render-recovery (the repo's gold standard)

For measurement pipelines the oracle problem is solved by generating the input from known ground
truth: `web/tests/helpers/paRender.ts`, `emRender.ts`, and `isRender.ts` draw synthetic coupon
images from known parameters (PA value, bead width, geometry), and the test asserts the pipeline
recovers those seed literals within a justified tolerance. `TestData_2solid.png` plays the same
role for the XY/XZ/YZ engine. The truth is the seed, never a computed expectation, so this
pattern satisfies the no-math rule. CLAUDE.md rule 1: measurement-math changes must keep these
tests green.

Caveat learned the hard way: a synthetic fixture generated from the same wrong equations as the
code validates the bug. Vary the generation path from the measurement path (different geometry
construction, non-cardinal placements) so a shared mistake cannot cancel out.

## Mutation testing

`npm run mutation` in `web/` runs Stryker over the core engine (see
[mutation-testing.md](mutation-testing.md) for scope and widening). Stryker plants small bugs
(mutants: flipped operators, deleted statements, changed constants) and reruns the covering
tests; a mutant that survives on covered core code is direct, mechanical evidence that the
covering tests are weak, exactly the "would it fail on a real bug" question answered empirically.
Run it on the touched module when in doubt about a test's strength.

## Property-based testing

For pure geometry and math stages (affine solving, robust statistics, coordinate transforms),
fast-check style property tests assert invariants over generated inputs instead of one example:
the median of a list is unchanged by permutation, a solved affine applied to the source points
reproduces the targets within tolerance, adding an outlier moves a robust estimate less than a
non-robust one. Properties are behavior statements, so they pass the refactoring-resistance test
by construction. Keep the invariant independent of the implementation (do not re-derive the
answer, state a relation that must hold).

## Metamorphic testing

When no oracle exists for a single input, relate the outputs of transformed inputs: rotate,
mirror, or scale the input and assert the recovered measurement transforms consistently (skew
flips sign under mirror, scale is invariant under rotation, a quarter-turned coupon reads its
axes swapped). The quarter-turn axis-leak tests in `emAnalyzer.spec.ts` are this pattern, with a
deliberately wrong figure on the unused axis to prove it cannot leak in; extend that pattern to
any new flow that converts pixels to millimetres.

## Tolerances

A float tolerance is a claim about the method's noise floor (quantization, sampling, solver
convergence), stated where it is chosen with the reason it is that size. It is never a convenient
round number picked to pass, and it is never widened to make a failing test pass: a failure
inside the old band is a regression to explain, not a band to stretch. Size the band tight
enough that a sign flip, a missing unit conversion, or a factor-of-2 error still fails.
