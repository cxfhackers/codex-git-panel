import { defineConfig } from 'vite';
// The app has one JS bundle; the MCP resource inlines it and needs no preload observer.
export default defineConfig({ build: { modulePreload: false } });
