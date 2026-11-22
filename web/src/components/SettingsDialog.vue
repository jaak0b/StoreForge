<script setup lang="ts">
import { computed } from 'vue';
import { useApp } from '../stores/app';
import { useSettings } from '../stores/settings';

const app = useApp();
const settings = useSettings();

const allowLocalAgent = computed({
  get: () => settings.allowLocalAgent,
  set: (allowed: boolean) => settings.setAllowLocalAgent(allowed),
});
</script>

<template>
  <v-dialog v-model="app.settingsOpen" max-width="520">
    <v-card>
      <v-card-title>Settings</v-card-title>
      <v-card-text>
        <v-switch
          v-model="allowLocalAgent"
          color="primary"
          density="compact"
          hide-details
          label="Allow a local AI agent to connect"
        />
        <p class="text-body-2 text-medium-emphasis mt-2">
          An AI agent on this computer, for example Claude Code with the WebMCP local relay,
          can then add, edit and remove queue entries. The browser may ask for permission to
          access the local network.
        </p>
        <v-alert
          v-if="!settings.allowLocalAgent && app.localAgentRelayLoaded"
          type="info"
          variant="tonal"
          density="compact"
          class="mt-3"
        >
          Reload the page to disconnect the agent.
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="app.settingsOpen = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
