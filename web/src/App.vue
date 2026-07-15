<script setup lang="ts">
import { useApp } from './stores/app';
import QueuePage from './components/QueuePage.vue';
import BinDesignerPage from './components/BinDesignerPage.vue';
import PlatePage from './components/PlatePage.vue';

const app = useApp();
</script>

<template>
  <v-app>
    <v-app-bar color="primary" density="comfortable">
      <v-app-bar-title>Gridfinity Generator</v-app-bar-title>
      <v-btn
        variant="text"
        :active="app.page === 'queue'"
        @click="app.showQueue()"
      >
        Queue
      </v-btn>
      <v-btn
        variant="text"
        :active="app.page === 'designer'"
        @click="app.openDesignerNew()"
      >
        Designer
      </v-btn>
      <v-btn
        variant="text"
        :active="app.page === 'plate'"
        @click="app.showPlate()"
      >
        Plate
      </v-btn>
    </v-app-bar>
    <v-main>
      <QueuePage v-if="app.page === 'queue'" />
      <PlatePage v-else-if="app.page === 'plate'" />
      <BinDesignerPage v-else :key="app.editingEntryId ?? 'new'" />
    </v-main>
  </v-app>
</template>
