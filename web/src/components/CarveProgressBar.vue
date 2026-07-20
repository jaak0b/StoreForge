<script setup lang="ts">
/**
 * The indeterminate progress bar shown while the worker is busy: the whole-bin
 * carve on the cutout tab and the per-model clearance offset in the model list
 * are the same wait, so they show the same bar. One definition keeps the two in
 * step; a caller adds spacing with a class of its own, which falls through to
 * the bar.
 */
</script>

<template>
  <v-progress-linear
    indeterminate
    striped
    color="primary"
    bg-color="grey-darken-3"
    bg-opacity="1"
    height="6"
    rounded
  />
</template>
