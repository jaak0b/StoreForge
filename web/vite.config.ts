import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// base './' keeps asset URLs relative, so the built site works both at a
// domain root and under a GitHub Pages project sub-path.
export default defineConfig({
  base: './',
  plugins: [vue()],
  worker: {
    format: 'es',
  },
});
