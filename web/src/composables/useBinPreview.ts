import { onMounted, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { generateLabeledBin } from '../workerClient';
import type { LabeledBinMeshes, LabeledBinParams } from '../engine/gridfinity/types';

/**
 * Debounced live 3D preview generation for a reactive set of bin parameters.
 * Regenerates in the geometry worker whenever the parameters change; stale
 * results are discarded by ticket so a slow generation never overwrites a
 * newer one.
 */
export function useBinPreview(
  params: () => LabeledBinParams,
  generate: (params: LabeledBinParams) => Promise<LabeledBinMeshes> = generateLabeledBin,
): {
  meshes: Ref<LabeledBinMeshes | null>;
  generating: Ref<boolean>;
  errorMessage: Ref<string | null>;
} {
  const meshes = ref<LabeledBinMeshes | null>(null);
  const generating = ref(false);
  const errorMessage = ref<string | null>(null);

  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let generationCounter = 0;

  async function regenerate(): Promise<void> {
    const ticket = ++generationCounter;
    generating.value = true;
    errorMessage.value = null;
    try {
      const result = await generate(params());
      if (ticket === generationCounter) meshes.value = result;
    } catch (error) {
      if (ticket === generationCounter) {
        errorMessage.value =
          error instanceof Error ? error.message : 'Bin generation failed.';
      }
    } finally {
      if (ticket === generationCounter) generating.value = false;
    }
  }

  function scheduleRegenerate(): void {
    if (debounceHandle !== null) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      void regenerate();
    }, 300);
  }

  watch(params, scheduleRegenerate, { deep: true });
  onMounted(() => void regenerate());
  onBeforeUnmount(() => {
    if (debounceHandle !== null) clearTimeout(debounceHandle);
  });

  return { meshes, generating, errorMessage };
}
