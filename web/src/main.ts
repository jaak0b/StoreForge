import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import './styles.css';
import App from './App.vue';
import { useBinQueue } from './stores/binQueue';
// Every colour the theme names lives in one module, because the 3D viewports
// need the same figures and no CSS variable reaches a WebGL material.
import {
  CARD,
  CONTROL,
  ERROR,
  INFO,
  MUTED_NEUTRAL,
  ON_PRIMARY,
  PAGE,
  PRIMARY,
  SUCCESS,
  TEXT,
  WARNING,
} from './themeColors';

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'workshop',
    themes: {
      // Warm graphite surfaces with a single muted amber accent. The accent is
      // reserved for the primary button, the active tab indicator and focus
      // rings; large areas stay neutral so nothing high-chroma is painted over
      // a big part of the screen.
      workshop: {
        dark: true,
        colors: {
          background: PAGE,
          surface: CARD,
          'surface-variant': CONTROL,
          // Vuetify's own lighter-surface token, kept on the control level so
          // components that reach for it land on the same step.
          'surface-bright': CONTROL,
          primary: PRIMARY,
          'on-primary': ON_PRIMARY,
          secondary: MUTED_NEUTRAL,
          success: SUCCESS,
          warning: WARNING,
          error: ERROR,
          info: INFO,
          'on-background': TEXT,
          'on-surface': TEXT,
          'on-surface-variant': TEXT,
        },
        variables: {
          // Body text sits at full strength; secondary text at this opacity.
          // Those two levels are the whole text ramp.
          'medium-emphasis-opacity': 0.68,
          'border-color': MUTED_NEUTRAL,
          'border-opacity': 0.9,
        },
      },
    },
  },
  defaults: {
    VBtn: { variant: 'flat', rounded: 'lg' },
    VCard: { rounded: 'lg', flat: true },
    // Outlined inputs so fields read as thin outlines rather than filled slabs.
    VTextField: { variant: 'outlined', density: 'comfortable', rounded: 'lg' },
    VTextarea: { variant: 'outlined', rounded: 'lg' },
    VSelect: { variant: 'outlined', density: 'comfortable', rounded: 'lg' },
    VChip: { rounded: 'lg' },
  },
});

const pinia = createPinia();
createApp(App).use(pinia).use(vuetify).mount('#app');

// Stored blobs orphaned by an interrupted session (photo or model stored, plan
// mutation never persisted) are cleaned up once at startup. The same pass reads
// which cutout models this device holds, so rows can name the ones it does not.
void useBinQueue(pinia).sweepStoredAssets();
