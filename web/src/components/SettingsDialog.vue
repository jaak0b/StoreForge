<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RELAY_VERSION } from '../agentTools/localRelay';
import {
  agentHostOsFromPlatform,
  relaySetupCommands,
  type AgentHostOs,
} from '../agentTools/relaySetup';
import { useApp } from '../stores/app';
import { useSettings } from '../stores/settings';

const app = useApp();
const settings = useSettings();

const allowLocalAgent = computed({
  get: () => settings.allowLocalAgent,
  set: (allowed: boolean) => settings.setAllowLocalAgent(allowed),
});

const setupGuideOpen = ref(false);

/** userAgentData is newer than the DOM typings; navigator.platform is the fallback. */
const browserPlatform =
  (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
  navigator.platform;
const agentOs = ref<AgentHostOs>(agentHostOsFromPlatform(browserPlatform));
const setupCommands = computed(() => relaySetupCommands(agentOs.value));

type CopyTarget = 'claudeCode' | 'mcpServersJson';
const copiedTarget = ref<CopyTarget | null>(null);
const copyError = ref<string | null>(null);
// A copy confirmation describes the text of the system that was shown when copying.
watch(agentOs, () => {
  copiedTarget.value = null;
});

async function copySetupText(target: CopyTarget): Promise<void> {
  copyError.value = null;
  try {
    await navigator.clipboard.writeText(setupCommands.value[target]);
    copiedTarget.value = target;
  } catch (error) {
    copiedTarget.value = null;
    const reason = error instanceof Error ? error.message : String(error);
    copyError.value = `The text could not be copied to the clipboard (${reason}). Select it and copy it manually.`;
  }
}
</script>

<template>
  <v-dialog v-model="app.settingsOpen" max-width="560" scrollable>
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
        <v-expand-transition>
          <v-sheet v-if="setupGuideOpen" border rounded class="pa-3 mt-4 text-body-2">
            <ol class="setup-steps">
              <li>
                <p class="font-weight-medium">Install the relay in your AI agent once.</p>
                <v-btn-toggle
                  v-model="agentOs"
                  mandatory
                  density="compact"
                  variant="outlined"
                  class="my-2"
                >
                  <v-btn value="windows">Windows</v-btn>
                  <v-btn value="unix">macOS and Linux</v-btn>
                </v-btn-toggle>
                <p>For Claude Code, run this command:</p>
                <div class="setup-code">
                  <pre>{{ setupCommands.claudeCode }}</pre>
                  <v-btn
                    size="small"
                    variant="text"
                    :prepend-icon="copiedTarget === 'claudeCode' ? 'mdi-check' : 'mdi-content-copy'"
                    @click="copySetupText('claudeCode')"
                  >
                    {{ copiedTarget === 'claudeCode' ? 'Copied' : 'Copy' }}
                  </v-btn>
                </div>
                <p class="mt-2">
                  For other agents such as Claude Desktop or Cursor, add this entry to the MCP
                  server configuration:
                </p>
                <div class="setup-code">
                  <pre>{{ setupCommands.mcpServersJson }}</pre>
                  <v-btn
                    size="small"
                    variant="text"
                    :prepend-icon="copiedTarget === 'mcpServersJson' ? 'mdi-check' : 'mdi-content-copy'"
                    @click="copySetupText('mcpServersJson')"
                  >
                    {{ copiedTarget === 'mcpServersJson' ? 'Copied' : 'Copy' }}
                  </v-btn>
                </div>
                <v-alert
                  v-if="copyError !== null"
                  type="error"
                  variant="tonal"
                  density="compact"
                  class="mt-2"
                >
                  {{ copyError }}
                </v-alert>
                <p class="mt-2">
                  <strong>Required:</strong> Node.js 22 or newer. Restart the agent after adding
                  the relay.
                </p>
              </li>
              <li>
                <p>
                  Turn on the switch above and keep exactly one StoreForge tab open. With several
                  tabs open, the relay renames the tools.
                </p>
              </li>
              <li>
                <p>
                  Ask the agent in plain words, for example: "Add bins for m3x8 shcs x10, m4x16
                  fhcs x5 and baseplates for a 400 × 300 mm drawer on a 256 mm build plate."
                </p>
              </li>
              <li>
                <p>
                  The agent cannot download STL or 3MF files, create print batches, mark plates
                  as printed, or edit traced and cutout bins.
                </p>
              </li>
            </ol>
            <p class="text-caption text-medium-emphasis mt-2">Relay version {{ RELAY_VERSION }}</p>
          </v-sheet>
        </v-expand-transition>
      </v-card-text>
      <v-card-actions>
        <v-btn
          variant="text"
          :append-icon="setupGuideOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          @click="setupGuideOpen = !setupGuideOpen"
        >
          Setup guide
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="app.settingsOpen = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.setup-steps {
  padding-left: 1.25rem;
}
.setup-steps > li + li {
  margin-top: 0.75rem;
}
.setup-code {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin-top: 0.25rem;
  padding: 0.5rem;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.setup-code pre {
  flex: 1;
  margin: 0;
  overflow-x: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.8125rem;
  white-space: pre;
}
</style>
