import { defineConfig, type Plugin } from "vite";

/**
 * Rapier ships its physics as a 3 MB WebAssembly module imported "ESM-style". Instead of the
 * compat build (wasm inlined as base64: +33% size and no streaming compile), we replace that
 * import with the plain JS bindings and load the .wasm file ourselves with
 * WebAssembly.instantiateStreaming (see src/engine/rapierWasm.ts): smaller download, and the
 * browser compiles while it downloads.
 */
function rapierWasm(): Plugin {
  const GLUE = "\0stresst-rapier-glue";
  return {
    name: "stresst-rapier-wasm",
    enforce: "pre",
    resolveId(id, importer) {
      if ((id === "./rapier_wasm3d" || id === "./rapier_wasm3d.js") && importer?.replace(/\\/g, "/").includes("/@dimforge/rapier3d/")) return GLUE;
      return null;
    },
    load(id) {
      return id === GLUE ? `export * from "@dimforge/rapier3d/rapier_wasm3d_bg.js";` : null;
    },
  };
}

export default defineConfig({
  // Relative asset paths so the same build works on a website subfolder and on itch.io.
  base: "./",
  plugins: [rapierWasm()],
  optimizeDeps: {
    // Let the plugin above handle Rapier instead of the dev pre-bundler.
    exclude: ["@dimforge/rapier3d"],
  },
  build: {
    // Older browsers / low-end devices: avoid bleeding-edge syntax in the output.
    target: "es2020",
    sourcemap: false,
    assetsInlineLimit: (file) => (file.endsWith(".wasm") ? false : undefined),
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5180,
    strictPort: true,
  },
});
