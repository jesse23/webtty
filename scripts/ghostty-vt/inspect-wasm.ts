// Offline inspection of a libghostty-vt wasm: the exports the binding needs and what
// `ghostty_build_info` reports, recorded in the sidecar (util, ADR 041, ADR 059).

/** Exports the binding needs; a pin without them is refused before it is written. */
export const REQUIRED_EXPORTS = [
  'memory',
  '__indirect_function_table',
  'ghostty_type_json',
  'ghostty_wasm_alloc',
  'ghostty_wasm_free',
  'ghostty_build_info',
  'ghostty_terminal_new',
  'ghostty_terminal_free',
  'ghostty_terminal_vt_write',
  'ghostty_terminal_resize',
  'ghostty_terminal_scroll_viewport',
  'ghostty_render_state_new',
  'ghostty_render_state_update',
  'ghostty_key_encoder_encode',
];

/** What `ghostty_build_info` reports; the wasm does not record its commit. */
export interface WasmBuildInfo {
  version: string;
  versionBuild: string;
  optimize: string;
  simd: boolean;
  kittyGraphics: boolean;
  tmuxControlMode: boolean;
}

/** The sidecar's `wasm` record: the module's shape and its build info. */
export interface WasmInfo {
  imports: string[];
  exportCount: number;
  functionExports: number;
  nonFunctionExports: string[];
  initialMemoryBytes: number;
  buildInfo: WasmBuildInfo;
}

// A type literal, not an interface, so the cast from WebAssembly.Exports type-checks.
type BuildInfoExports = {
  memory: WebAssembly.Memory;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_build_info(id: number, out: number): number;
};

const OPTIMIZE_MODES = ['Debug', 'ReleaseSafe', 'ReleaseSmall', 'ReleaseFast'];

/** Reads the build info fields through a 16-byte out buffer in wasm memory. */
function readBuildInfo(ex: BuildInfoExports): WasmBuildInfo {
  const out = ex.ghostty_wasm_alloc(16);
  const query = (id: number) => {
    const rc = ex.ghostty_build_info(id, out);
    if (rc !== 0) throw new Error(`wasm: ghostty_build_info(${id}) returned ${rc}`);
    return new DataView(ex.memory.buffer);
  };
  const str = (id: number) => {
    const view = query(id);
    const ptr = view.getUint32(out, true);
    const len = view.getUint32(out + 4, true);
    return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len));
  };
  const bool = (id: number) => query(id).getUint8(out) !== 0;
  const optimize = query(4).getUint32(out, true);
  const buildInfo = {
    version: str(5),
    versionBuild: str(10),
    optimize: OPTIMIZE_MODES[optimize] ?? String(optimize),
    simd: bool(1),
    kittyGraphics: bool(2),
    tmuxControlMode: bool(3),
  };
  ex.ghostty_wasm_free(out, 16);
  return buildInfo;
}

/**
 * Instantiates the wasm, checks the exports the binding needs and reads `ghostty_build_info`.
 *
 * @throws If the module does not validate, needs imports or lacks a required export.
 */
export async function inspectWasm(bytes: Uint8Array<ArrayBuffer>): Promise<WasmInfo> {
  if (!WebAssembly.validate(bytes)) throw new Error('wasm: WebAssembly.validate failed');
  const mod = new WebAssembly.Module(bytes);
  // The binding instantiates the wasm with no imports, so a module that needs any is refused.
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}:${i.kind}`);
  if (imports.length) throw new Error(`wasm: unexpected imports ${imports.join(', ')}`);
  const exports = WebAssembly.Module.exports(mod);
  const names = new Set(exports.map((e) => e.name));
  const missing = REQUIRED_EXPORTS.filter((n) => !names.has(n));
  if (missing.length) throw new Error(`wasm: missing exports ${missing.join(', ')}`);
  const instance = await WebAssembly.instantiate(mod, {});
  const ex = instance.exports as BuildInfoExports;
  const buildInfo = readBuildInfo(ex);
  return {
    imports,
    exportCount: exports.length,
    functionExports: exports.filter((e) => e.kind === 'function').length,
    nonFunctionExports: exports
      .filter((e) => e.kind !== 'function')
      .map((e) => `${e.name}:${e.kind}`),
    initialMemoryBytes: ex.memory.buffer.byteLength,
    buildInfo,
  };
}
