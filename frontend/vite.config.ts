import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // main.tsx uses a top-level await (loadConfig() before render); target
    // modern evergreen browsers that support it natively.
    target: 'es2022',
  },
});
