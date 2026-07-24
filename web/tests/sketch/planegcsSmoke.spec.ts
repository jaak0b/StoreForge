import { describe, expect, it } from 'vitest';
import { loadGcsWrapper } from '../helpers/planegcs';

// The sketch worker itself cannot run under node (Comlink), so this smoke
// test exercises the same library it loads, following the vision smoke test
// pattern in tests/vision/visionSmoke.spec.ts.

describe('planegcs wasm', () => {
  it('loads the wasm and solves a one-constraint system', async () => {
    const wrapper = await loadGcsWrapper();
    wrapper.push_primitives_and_params([
      { id: '1', type: 'point', x: 0, y: 0, fixed: true },
      { id: '2', type: 'point', x: 3, y: 4, fixed: false },
      { id: '3', type: 'p2p_distance', p1_id: '1', p2_id: '2', distance: 10 },
    ]);
    const status = wrapper.solve();
    expect(status).toBeLessThanOrEqual(1); // Success (0) or Converged (1)
    wrapper.apply_solution();
    const p2 = wrapper.sketch_index.get_primitive_or_fail('2') as {
      x: number;
      y: number;
    };
    expect(Math.hypot(p2.x, p2.y)).toBeCloseTo(10, 6);
    expect(wrapper.gcs.dof()).toBe(1); // a point on a circle has one dof left
    wrapper.destroy_gcs_module();
  });
});
