import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, reactive, nextTick } from 'vue';
import { useBinPreview } from '../../src/composables/useBinPreview';

/**
 * The composable's contract that the cutout tab leans on: a result carries its
 * own identity and an older carve can never overwrite a newer one. The cutout
 * tab bundles the model ids into the result it returns, so if a superseded
 * carve that finished late were allowed to land, its footprints and warnings
 * would map onto the wrong rows. These tests stand in a tagged object for that
 * result and drive two carves that resolve out of order.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let the composable's awaited continuations and Vue's watcher jobs run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

interface TaggedResult {
  id: string;
}

/**
 * Mounts the composable in an effect scope, driving it through a reactive
 * parameter and a queue of deferred results the test resolves by hand. onMounted
 * does not run outside a component instance, so the initial carve is skipped and
 * every carve here is one the parameter change started.
 */
function harness() {
  const params = reactive({ n: 0 });
  const deferreds: Deferred<TaggedResult>[] = [];
  const generate = vi.fn((): Promise<TaggedResult> => {
    const d = defer<TaggedResult>();
    deferreds.push(d);
    return d.promise;
  });
  const scope = effectScope();
  let api!: ReturnType<typeof useBinPreview<{ n: number }, TaggedResult>>;
  scope.run(() => {
    api = useBinPreview<{ n: number }, TaggedResult>(() => ({ ...params }), generate);
  });
  return { params, deferreds, generate, scope, api };
}

/** Change the parameter and let the 300 ms debounce elapse, starting one carve. */
async function startCarve(params: { n: number }, n: number): Promise<void> {
  params.n = n;
  await nextTick();
  await vi.advanceTimersByTimeAsync(300);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useBinPreview', () => {
  it('drops a superseded carve that finishes after the newer one', async () => {
    vi.useFakeTimers();
    const { params, deferreds, generate, scope, api } = harness();

    await startCarve(params, 1);
    await startCarve(params, 2);
    expect(generate).toHaveBeenCalledTimes(2);

    // The newer (second) carve lands first and is shown.
    deferreds[1].resolve({ id: 'B' });
    await flush();
    expect(api.meshes.value).toEqual({ id: 'B' });

    // The older (first) carve finishes late; its result must not replace the
    // newer one, so the id the tab reads always belongs to the shown carve.
    deferreds[0].resolve({ id: 'A' });
    await flush();
    expect(api.meshes.value).toEqual({ id: 'B' });

    scope.stop();
  });

  it('shows each carve as it lands when they finish in order', async () => {
    vi.useFakeTimers();
    const { params, deferreds, generate, scope, api } = harness();

    await startCarve(params, 1);
    await startCarve(params, 2);
    expect(generate).toHaveBeenCalledTimes(2);

    // The older carve finishes first: progressive display shows it rather than
    // freezing until the newer one is done.
    deferreds[0].resolve({ id: 'A' });
    await flush();
    expect(api.meshes.value).toEqual({ id: 'A' });

    // The newer carve then supersedes it on screen.
    deferreds[1].resolve({ id: 'B' });
    await flush();
    expect(api.meshes.value).toEqual({ id: 'B' });

    scope.stop();
  });
});
