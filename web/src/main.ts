import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'workshop',
    themes: {
      workshop: {
        dark: true,
        colors: {
          background: '#1e1f22',
          surface: '#2b2d31',
          'surface-bright': '#313338',
          'surface-variant': '#383a40',
          'on-surface-variant': '#dbdee1',
          primary: '#5865f2',
          secondary: '#4e5058',
          success: '#23a55a',
          warning: '#f0b232',
          error: '#da373c',
          info: '#00a8fc',
          'on-background': '#dbdee1',
          'on-surface': '#dbdee1',
        },
        variables: {
          'medium-emphasis-opacity': 0.64,
          'border-color': '#3f4147',
          'border-opacity': 0.8,
        },
      },
    },
  },
  defaults: {
    VBtn: { variant: 'flat', rounded: 'lg' },
    VCard: { rounded: 'lg', flat: true },
    VTextField: { variant: 'solo-filled', flat: true, density: 'comfortable', rounded: 'lg' },
    VTextarea: { variant: 'solo-filled', flat: true, rounded: 'lg' },
    VSelect: { variant: 'solo-filled', flat: true, density: 'comfortable', rounded: 'lg' },
    VChip: { rounded: 'lg' },
  },
});

createApp(App).use(createPinia()).use(vuetify).mount('#app');
