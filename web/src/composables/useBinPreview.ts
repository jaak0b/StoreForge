import { onMounted, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { generateSlottedBin } from '../workerClient';
import type { PartMeshes, SlottedBinParams } from '../engine/gridfinity/types';

/**
 * Debounced live 3D preview generation for a reactive set of part
 * parameters. Regenerates in the geometry worker whenever the parameters
 * change; results display progressively by ticket: a superseded carve's
 * meshes still display if nothing newer has displayed yet, so long waits
 * show each completed step instead of freezing, while an older result can
 * never overwrite a newer one. Generic over the parameter shape so the tabs can
 * preview slotted bins, pocket bins or standalone inserts with one
 * composable.
 *
 * Generic over the result shape too, defaulting to the two meshes. A cutout
 * carve returns its placement warnings and its post-dilation footprints
 * alongside the meshes, because neither can be recomputed downstream without
 * redoing the carve, and the result type flows through rather than being
 * flattened here. The default keeps every existing call site unchanged.
 */
export function useBinPreview<P = SlottedBinParams, R = PartMeshes>(
  params: () => P,
  generate: (params: P) => Promise<R> = generateSlottedBin as unknown as (
    params: P,
  ) => Promise<R>,
): {
  meshes: Ref<R | null>;
  generating: Ref<boolean>;
  errorMessage: Ref<string | null>;
} {
  const meshes = ref<R | null>(null) as Ref<R | null>;
  const generating = ref(false);
  const errorMessage = ref<string | null>(null);

  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let generationCounter = 0;
  let displayedTicket = 0;

  async function regenerate(): Promise<void> {
    const ticket = ++generationCounter;
    generating.value = true;
    errorMessage.value = null;
    try {
      const result = await generate(params());
      if (ticket > displayedTicket) {
        displayedTicket = ticket;
        meshes.value = result;
      }
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
