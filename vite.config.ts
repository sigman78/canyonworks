import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173 },
  // `@wasm` -> the wasm-pack bundle; Vite still fingerprints the .wasm asset
  // (the `--target web` output loads it via new URL(..., import.meta.url)).
  // Keeps the ../../wasm/pkg relative path out of the source.
  resolve: {
    alias: { '@wasm': fileURLToPath(new URL('./wasm/pkg/canyonworks_wasm.js', import.meta.url)) },
  },
});
