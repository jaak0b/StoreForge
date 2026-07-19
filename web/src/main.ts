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

// The surface ladder, darkest to lightest: page, card, control. Every grey in
// the app resolves to one of these three, and the muted neutral is also the
// hairline border colour, so none of them is written down twice.
const PAGE = '#101010';
const CARD = '#1a1a1a';
const CONTROL = '#2f2f2f';
const MUTED_NEUTRAL = '#444444';
// Warm off-white body text. The second text level is this colour at the
// medium-emphasis opacity below, and there is no third level.
const TEXT = '#ece7df';

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
          primary: '#b8752a',
          // White label text on the amber accent, as reviewed and approved on
          // the mockup.
          'on-primary': '#ffffff',
          secondary: MUTED_NEUTRAL,
          success: '#23a55a',
          warning: '#f0b232',
          error: '#da373c',
          info: '#00a8fc',
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

// Stored trace photos orphaned by an interrupted session (photo stored, plan
// mutation never persisted) are cleaned up once at startup.
void useBinQueue(pinia).sweepStoredPhotos();
