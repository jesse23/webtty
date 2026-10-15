// webtty (ADR 042, ADR 061), not from upstream.
// The typing of the official libghostty-vt wasm's exports (types): one signature per C
// function the binding calls, with the by-value structs noted where wasm32 passes a pointer.

/**
 * Exports of the official wasm the binding calls (pointers, handles, size_t: i32), so
 * every export call is type-checked against the C API it wraps.
 */
export interface OfficialWasmExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(ptr: number): void;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_terminal_new(allocator: number, out: number, cols: number, rows: number): number;
  ghostty_terminal_free(term: number): void;
  ghostty_terminal_resize(
    term: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ): number;
  ghostty_terminal_set(term: number, option: number, value: number): number;
  ghostty_terminal_get(term: number, data: number, out: number): number;
  ghostty_terminal_get_multi(
    term: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number
  ): number;
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void;
  ghostty_terminal_vt_write_until_ground(
    term: number,
    ptr: number,
    len: number,
    outConsumed: number
  ): number;
  ghostty_terminal_paste(term: number, paste: number, outWritten: number): number;
  /** The GhosttyTerminalScrollViewport struct is passed by value, i.e. by pointer on wasm32. */
  ghostty_terminal_scroll_viewport(term: number, behavior: number): void;
  /** The GhosttyPoint struct is passed by value, i.e. by pointer on wasm32. */
  ghostty_terminal_grid_ref(term: number, point: number, outRef: number): number;
  ghostty_grid_ref_row(ref: number, outRow: number): number;
  ghostty_terminal_point_from_grid_ref(term: number, ref: number, tag: number, out: number): number;
  ghostty_terminal_select_word(term: number, options: number, outSelection: number): number;
  ghostty_terminal_select_line(term: number, options: number, outSelection: number): number;
  /** The GhosttyGridRef struct is passed by value, i.e. by pointer on wasm32. */
  ghostty_terminal_select_output(term: number, ref: number, outSelection: number): number;
  /** GhosttyTerminalSelectionFormatOptions is passed by value, i.e. by pointer on wasm32. */
  ghostty_terminal_selection_format_alloc(
    term: number,
    allocator: number,
    options: number,
    outPtr: number,
    outLen: number
  ): number;
  ghostty_free(allocator: number, ptr: number, len: number): void;
  ghostty_grid_ref_hyperlink_uri(ref: number, buf: number, len: number, outLen: number): number;
  /** GhosttyRow is a u64 passed by value (a BigInt on the JS side). */
  ghostty_row_get(row: bigint, data: number, out: number): number;
  ghostty_render_state_new(allocator: number, out: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, term: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_get(state: number, data: number, out: number): number;
  ghostty_render_state_get_multi(
    state: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number
  ): number;
  ghostty_render_state_row_iterator_new(allocator: number, out: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_iterator_next(iterator: number): number;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): number;
  ghostty_render_state_row_get_multi(
    iterator: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number
  ): number;
  ghostty_render_state_row_cells_new(allocator: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number;
  ghostty_key_encoder_new(allocator: number, out: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    buf: number,
    len: number,
    outLen: number
  ): number;
  ghostty_key_event_new(allocator: number, out: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
  ghostty_mouse_encoder_new(allocator: number, out: number): number;
  ghostty_mouse_encoder_free(encoder: number): void;
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, term: number): void;
  ghostty_mouse_encoder_encode(
    encoder: number,
    event: number,
    buf: number,
    len: number,
    outLen: number
  ): number;
  ghostty_mouse_event_new(allocator: number, out: number): number;
  ghostty_mouse_event_free(event: number): void;
  ghostty_mouse_event_set_action(event: number, action: number): void;
  ghostty_mouse_event_set_button(event: number, button: number): void;
  ghostty_mouse_event_clear_button(event: number): void;
  ghostty_mouse_event_set_mods(event: number, mods: number): void;
  /** The GhosttyMousePosition struct is passed by value, i.e. by pointer on wasm32. */
  ghostty_mouse_event_set_position(event: number, position: number): void;
  ghostty_focus_encode(event: number, buf: number, len: number, outWritten: number): number;
  ghostty_search_new(allocator: number, out: number, term: number): number;
  ghostty_search_free(search: number): void;
  ghostty_search_tick(search: number, outStatus: number): number;
  ghostty_search_feed(search: number): number;
  ghostty_search_set(search: number, option: number, value: number): number;
  ghostty_search_get(search: number, data: number, out: number): number;
}
