import * as bindings from "@dimforge/rapier3d/rapier_wasm3d_bg.js";
import wasmUrl from "@dimforge/rapier3d/rapier_wasm3d_bg.wasm?url";

/**
 * Loads Rapier's WebAssembly with streaming compilation (the module compiles while it downloads)
 * and hands it to the JS bindings. Falls back to a plain fetch when the server does not send the
 * application/wasm MIME type that streaming needs.
 */
export async function initRapierWasm(): Promise<void> {
  const imports = { "./rapier_wasm3d_bg.js": bindings as unknown as WebAssembly.ModuleImports };
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports));
  } catch {
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, imports));
  }
  bindings.__wbg_set_wasm(instance.exports);
}
