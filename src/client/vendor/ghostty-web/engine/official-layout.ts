// webtty (ADR 042, ADR 061), not from upstream.
// The binding's layout table (constants, a data table): every enum value, struct offset
// and bit field the official binding uses, resolved from the manifest once per instance,
// with a named type per feature so each part of the binding takes only its own.

import type { MouseButton } from './engine-types';
import type { RenderStateCursor } from './cell-types';
import type { VtLayout } from './vt-layout';

/** Enum values, offsets and bit fields the official binding uses, resolved once per instance. */
export function resolveOfficialLayout(layout: VtLayout) {
  const opt = (k: string) => layout.value('GhosttyTerminalOption', k);
  const tdata = (k: string) => layout.value('GhosttyTerminalData', k);
  const cellBits = layout.type('GhosttyCell').bits;
  const cp = layout.armBits('GhosttyCell', 'content', 'CODEPOINT');
  const cpg = layout.armBits('GhosttyCell', 'content', 'CODEPOINT_GRAPHEME');
  const pal = layout.armBits('GhosttyCell', 'content', 'BG_COLOR_PALETTE');
  const rgb = layout.armBits('GhosttyCell', 'content', 'BG_COLOR_RGB');
  const codepoint = layout.bitField(cp, 'codepoint');
  const graphemeCodepoint = layout.bitField(cpg, 'codepoint');
  if (codepoint.lsb !== graphemeCodepoint.lsb || codepoint.mask !== graphemeCodepoint.mask) {
    throw new Error('libghostty-vt GhosttyCell codepoint arms differ');
  }
  return {
    opt: {
      WRITE_PTY: opt('WRITE_PTY'),
      BELL: opt('BELL'),
      TITLE_CHANGED: opt('TITLE_CHANGED'),
      SIZE: opt('SIZE'),
      DEVICE_ATTRIBUTES: opt('DEVICE_ATTRIBUTES'),
      COLOR_FOREGROUND: opt('COLOR_FOREGROUND'),
      COLOR_BACKGROUND: opt('COLOR_BACKGROUND'),
      COLOR_CURSOR: opt('COLOR_CURSOR'),
      COLOR_PALETTE: opt('COLOR_PALETTE'),
      SCROLLBACK_MAX_BYTES: opt('SCROLLBACK_MAX_BYTES'),
      SCROLLBACK_MAX_LINES: opt('SCROLLBACK_MAX_LINES'),
      MODE_DEFAULT: opt('MODE_DEFAULT'),
      MODE: opt('MODE'),
      DEFAULT_CURSOR_STYLE: opt('DEFAULT_CURSOR_STYLE'),
      DEFAULT_CURSOR_BLINK: opt('DEFAULT_CURSOR_BLINK'),
      CLIPBOARD_WRITE: opt('CLIPBOARD_WRITE'),
      DESKTOP_NOTIFICATION: opt('DESKTOP_NOTIFICATION'),
    },
    defaultCursorStyle: {
      bar: layout.value('GhosttyTerminalCursorStyle', 'BAR'),
      block: layout.value('GhosttyTerminalCursorStyle', 'BLOCK'),
      underline: layout.value('GhosttyTerminalCursorStyle', 'UNDERLINE'),
    } satisfies Record<RenderStateCursor['style'], number>,
    tdata: {
      CURSOR_X: tdata('CURSOR_X'),
      CURSOR_Y: tdata('CURSOR_Y'),
      ACTIVE_SCREEN: tdata('ACTIVE_SCREEN'),
      MOUSE_TRACKING: tdata('MOUSE_TRACKING'),
      CURSOR_AT_PROMPT: tdata('CURSOR_AT_PROMPT'),
      SCROLLBAR: tdata('SCROLLBAR'),
      TITLE: tdata('TITLE'),
      SCROLLBACK_ROWS: tdata('SCROLLBACK_ROWS'),
      COLOR_PALETTE_DEFAULT: tdata('COLOR_PALETTE_DEFAULT'),
      MODE: tdata('MODE'),
    },
    screenAlternate: layout.value('GhosttyTerminalScreen', 'ALTERNATE'),
    rs: {
      DIRTY: layout.value('GhosttyRenderStateData', 'DIRTY'),
      ROW_ITERATOR: layout.value('GhosttyRenderStateData', 'ROW_ITERATOR'),
      CURSOR: layout.value('GhosttyRenderStateData', 'CURSOR'),
      COLORS: layout.value('GhosttyRenderStateData', 'COLORS'),
    },
    dirty: {
      FALSE: layout.value('GhosttyRenderStateDirty', 'FALSE'),
      PARTIAL: layout.value('GhosttyRenderStateDirty', 'PARTIAL'),
      FULL: layout.value('GhosttyRenderStateDirty', 'FULL'),
    },
    row: {
      CELLS: layout.value('GhosttyRenderStateRowData', 'CELLS'),
      CELLS_RAW: layout.value('GhosttyRenderStateRowData', 'CELLS_RAW'),
      VIEWPORT_Y: layout.value('GhosttyRenderStateRowData', 'VIEWPORT_Y'),
    },
    cellData: {
      STYLE: layout.value('GhosttyRenderStateRowCellsData', 'STYLE'),
      GRAPHEMES_LEN: layout.value('GhosttyRenderStateRowCellsData', 'GRAPHEMES_LEN'),
      GRAPHEMES_BUF: layout.value('GhosttyRenderStateRowCellsData', 'GRAPHEMES_BUF'),
    },
    rowWrapContinuation: layout.value('GhosttyRowData', 'WRAP_CONTINUATION'),
    cell: {
      tag: layout.bitField(cellBits, 'content_tag'),
      content: layout.bitField(cellBits, 'content'),
      style: layout.bitField(cellBits, 'style_id'),
      wide: layout.bitField(cellBits, 'wide'),
      hyperlink: layout.bitField(cellBits, 'hyperlink'),
      codepoint,
      paletteIndex: layout.bitField(pal, 'index'),
      r: layout.bitField(rgb, 'r'),
      g: layout.bitField(rgb, 'g'),
      b: layout.bitField(rgb, 'b'),
    },
    tag: {
      CODEPOINT: layout.value('GhosttyCellContentTag', 'CODEPOINT'),
      CODEPOINT_GRAPHEME: layout.value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
      BG_COLOR_PALETTE: layout.value('GhosttyCellContentTag', 'BG_COLOR_PALETTE'),
      BG_COLOR_RGB: layout.value('GhosttyCellContentTag', 'BG_COLOR_RGB'),
    },
    wide: {
      NARROW: layout.value('GhosttyCellWide', 'NARROW'),
      WIDE: layout.value('GhosttyCellWide', 'WIDE'),
    },
    styleColor: {
      NONE: layout.value('GhosttyStyleColorTag', 'NONE'),
      PALETTE: layout.value('GhosttyStyleColorTag', 'PALETTE'),
      RGB: layout.value('GhosttyStyleColorTag', 'RGB'),
      tag: layout.offset('GhosttyStyleColor', 'tag'),
      value: layout.offset('GhosttyStyleColor', 'value'),
      palette: layout.offset('GhosttyStyleColorValue', 'palette'),
      rgb: layout.offset('GhosttyStyleColorValue', 'rgb'),
    },
    style: {
      size: layout.size('GhosttyStyle'),
      sizeField: layout.offset('GhosttyStyle', 'size'),
      fg: layout.offset('GhosttyStyle', 'fg_color'),
      bg: layout.offset('GhosttyStyle', 'bg_color'),
      bold: layout.offset('GhosttyStyle', 'bold'),
      italic: layout.offset('GhosttyStyle', 'italic'),
      faint: layout.offset('GhosttyStyle', 'faint'),
      blink: layout.offset('GhosttyStyle', 'blink'),
      inverse: layout.offset('GhosttyStyle', 'inverse'),
      invisible: layout.offset('GhosttyStyle', 'invisible'),
      strikethrough: layout.offset('GhosttyStyle', 'strikethrough'),
      underline: layout.offset('GhosttyStyle', 'underline'),
    },
    cursor: {
      size: layout.size('GhosttyRenderStateCursor'),
      sizeField: layout.offset('GhosttyRenderStateCursor', 'size'),
      visible: layout.offset('GhosttyRenderStateCursor', 'visible'),
      blinking: layout.offset('GhosttyRenderStateCursor', 'blinking'),
      visualStyle: layout.offset('GhosttyRenderStateCursor', 'visual_style'),
    },
    cursorStyle: {
      BAR: layout.value('GhosttyRenderStateCursorVisualStyle', 'BAR'),
      BLOCK: layout.value('GhosttyRenderStateCursorVisualStyle', 'BLOCK'),
      UNDERLINE: layout.value('GhosttyRenderStateCursorVisualStyle', 'UNDERLINE'),
    },
    colors: {
      size: layout.size('GhosttyRenderStateColors'),
      sizeField: layout.offset('GhosttyRenderStateColors', 'size'),
      background: layout.offset('GhosttyRenderStateColors', 'background'),
      foreground: layout.offset('GhosttyRenderStateColors', 'foreground'),
      palette: layout.offset('GhosttyRenderStateColors', 'palette'),
      rgbSize: layout.size('GhosttyColorRgb'),
      r: layout.offset('GhosttyColorRgb', 'r'),
      g: layout.offset('GhosttyColorRgb', 'g'),
      b: layout.offset('GhosttyColorRgb', 'b'),
    },
    cellsView: {
      size: layout.size('GhosttyCellsView'),
      ptr: layout.offset('GhosttyCellsView', 'ptr'),
      len: layout.offset('GhosttyCellsView', 'len'),
    },
    cellSize: layout.size('GhosttyCell'),
    scroll: {
      size: layout.size('GhosttyTerminalScrollViewport'),
      tag: layout.offset('GhosttyTerminalScrollViewport', 'tag'),
      value: layout.offset('GhosttyTerminalScrollViewport', 'value'),
      BOTTOM: layout.value('GhosttyTerminalScrollViewportTag', 'BOTTOM'),
      ROW: layout.value('GhosttyTerminalScrollViewportTag', 'ROW'),
      DELTA_PROMPT: layout.value('GhosttyTerminalScrollViewportTag', 'DELTA_PROMPT'),
    },
    scrollbar: {
      size: layout.size('GhosttyTerminalScrollbar'),
      offset: layout.offset('GhosttyTerminalScrollbar', 'offset'),
    },
    point: {
      size: layout.size('GhosttyPoint'),
      tag: layout.offset('GhosttyPoint', 'tag'),
      value: layout.offset('GhosttyPoint', 'value'),
      x: layout.offset('GhosttyPointCoordinate', 'x'),
      y: layout.offset('GhosttyPointCoordinate', 'y'),
      ACTIVE: layout.value('GhosttyPointTag', 'ACTIVE'),
      HISTORY: layout.value('GhosttyPointTag', 'HISTORY'),
      SCREEN: layout.value('GhosttyPointTag', 'SCREEN'),
    },
    gridRef: {
      size: layout.size('GhosttyGridRef'),
      sizeField: layout.offset('GhosttyGridRef', 'size'),
    },
    selection: {
      size: layout.size('GhosttySelection'),
      sizeField: layout.offset('GhosttySelection', 'size'),
      start: layout.offset('GhosttySelection', 'start'),
      end: layout.offset('GhosttySelection', 'end'),
      word: {
        size: layout.size('GhosttyTerminalSelectWordOptions'),
        sizeField: layout.offset('GhosttyTerminalSelectWordOptions', 'size'),
        ref: layout.offset('GhosttyTerminalSelectWordOptions', 'ref'),
      },
      line: {
        size: layout.size('GhosttyTerminalSelectLineOptions'),
        sizeField: layout.offset('GhosttyTerminalSelectLineOptions', 'size'),
        ref: layout.offset('GhosttyTerminalSelectLineOptions', 'ref'),
      },
      format: {
        size: layout.size('GhosttyTerminalSelectionFormatOptions'),
        sizeField: layout.offset('GhosttyTerminalSelectionFormatOptions', 'size'),
        emit: layout.offset('GhosttyTerminalSelectionFormatOptions', 'emit'),
        unwrap: layout.offset('GhosttyTerminalSelectionFormatOptions', 'unwrap'),
        trim: layout.offset('GhosttyTerminalSelectionFormatOptions', 'trim'),
        selection: layout.offset('GhosttyTerminalSelectionFormatOptions', 'selection'),
      },
      PLAIN: layout.value('GhosttyFormatterFormat', 'PLAIN'),
    },
    string: {
      size: layout.size('GhosttyString'),
      ptr: layout.offset('GhosttyString', 'ptr'),
      len: layout.offset('GhosttyString', 'len'),
    },
    mode: {
      size: layout.size('GhosttyTerminalModeConfig'),
      mode: layout.offset('GhosttyTerminalModeConfig', 'mode'),
      value: layout.offset('GhosttyTerminalModeConfig', 'value'),
    },
    sizeReport: {
      rows: layout.offset('GhosttySizeReportSize', 'rows'),
      columns: layout.offset('GhosttySizeReportSize', 'columns'),
      cellWidth: layout.offset('GhosttySizeReportSize', 'cell_width'),
      cellHeight: layout.offset('GhosttySizeReportSize', 'cell_height'),
    },
    da: {
      primary: layout.offset('GhosttyDeviceAttributes', 'primary'),
      secondary: layout.offset('GhosttyDeviceAttributes', 'secondary'),
      tertiary: layout.offset('GhosttyDeviceAttributes', 'tertiary'),
      conformance: layout.offset('GhosttyDeviceAttributesPrimary', 'conformance_level'),
      features: layout.offset('GhosttyDeviceAttributesPrimary', 'features'),
      numFeatures: layout.offset('GhosttyDeviceAttributesPrimary', 'num_features'),
      deviceType: layout.offset('GhosttyDeviceAttributesSecondary', 'device_type'),
      firmware: layout.offset('GhosttyDeviceAttributesSecondary', 'firmware_version'),
      rom: layout.offset('GhosttyDeviceAttributesSecondary', 'rom_cartridge'),
      unitId: layout.offset('GhosttyDeviceAttributesTertiary', 'unit_id'),
    },
    mouse: {
      size: layout.size('GhosttyMouseEncoderSize'),
      sizeField: layout.offset('GhosttyMouseEncoderSize', 'size'),
      screenWidth: layout.offset('GhosttyMouseEncoderSize', 'screen_width'),
      screenHeight: layout.offset('GhosttyMouseEncoderSize', 'screen_height'),
      cellWidth: layout.offset('GhosttyMouseEncoderSize', 'cell_width'),
      cellHeight: layout.offset('GhosttyMouseEncoderSize', 'cell_height'),
      paddingTop: layout.offset('GhosttyMouseEncoderSize', 'padding_top'),
      paddingBottom: layout.offset('GhosttyMouseEncoderSize', 'padding_bottom'),
      paddingRight: layout.offset('GhosttyMouseEncoderSize', 'padding_right'),
      paddingLeft: layout.offset('GhosttyMouseEncoderSize', 'padding_left'),
      positionSize: layout.size('GhosttyMousePosition'),
      x: layout.offset('GhosttyMousePosition', 'x'),
      y: layout.offset('GhosttyMousePosition', 'y'),
      SIZE: layout.value('GhosttyMouseEncoderOption', 'SIZE'),
      ANY_BUTTON_PRESSED: layout.value('GhosttyMouseEncoderOption', 'ANY_BUTTON_PRESSED'),
      TRACK_LAST_CELL: layout.value('GhosttyMouseEncoderOption', 'TRACK_LAST_CELL'),
      action: {
        press: layout.value('GhosttyMouseAction', 'PRESS'),
        release: layout.value('GhosttyMouseAction', 'RELEASE'),
        motion: layout.value('GhosttyMouseAction', 'MOTION'),
      },
      button: {
        left: layout.value('GhosttyMouseButton', 'LEFT'),
        middle: layout.value('GhosttyMouseButton', 'MIDDLE'),
        right: layout.value('GhosttyMouseButton', 'RIGHT'),
        four: layout.value('GhosttyMouseButton', 'FOUR'),
        five: layout.value('GhosttyMouseButton', 'FIVE'),
        eight: layout.value('GhosttyMouseButton', 'EIGHT'),
        nine: layout.value('GhosttyMouseButton', 'NINE'),
      } satisfies Record<MouseButton, number>,
    },
    paste: {
      size: layout.size('GhosttyPaste'),
      sizeField: layout.offset('GhosttyPaste', 'size'),
      location: layout.offset('GhosttyPaste', 'location'),
      source: layout.offset('GhosttyPaste', 'source'),
      mimes: layout.offset('GhosttyPaste', 'mimes'),
      mimesLen: layout.offset('GhosttyPaste', 'mimes_len'),
      reader: layout.offset('GhosttyPaste', 'reader'),
      allowUnsafe: layout.offset('GhosttyPaste', 'allow_unsafe'),
      readerRead: layout.offset('GhosttyMimeReader', 'read'),
      writerWrite: layout.offset('GhosttyWriter', 'write'),
      writerUserdata: layout.offset('GhosttyWriter', 'userdata'),
      STANDARD: layout.value('GhosttyClipboardLocation', 'STANDARD'),
      CLIPBOARD: layout.value('GhosttyPasteSource', 'CLIPBOARD'),
    },
    notification: {
      size: layout.offset('GhosttyTerminalDesktopNotification', 'size'),
      title: layout.offset('GhosttyTerminalDesktopNotification', 'title'),
      body: layout.offset('GhosttyTerminalDesktopNotification', 'body'),
      bodyEnd: layout.offset('GhosttyTerminalDesktopNotification', 'body') + layout.size('GhosttyString'),
    },
    clipboardWrite: {
      location: layout.offset('GhosttyClipboardWrite', 'location'),
      contents: layout.offset('GhosttyClipboardWrite', 'contents'),
      contentsLen: layout.offset('GhosttyClipboardWrite', 'contents_len'),
      reply: layout.offset('GhosttyClipboardWrite', 'reply'),
      contentSize: layout.size('GhosttyClipboardContent'),
      mime: layout.offset('GhosttyClipboardContent', 'mime'),
      data: layout.offset('GhosttyClipboardContent', 'data'),
      replySize: layout.size('GhosttyClipboardWriteReply'),
      replySizeField: layout.offset('GhosttyClipboardWriteReply', 'size'),
      replyResult: layout.offset('GhosttyClipboardWriteReply', 'result'),
      STANDARD: layout.value('GhosttyClipboardLocation', 'STANDARD'),
      SUCCESS: layout.value('GhosttyClipboardWriteResult', 'SUCCESS'),
      UNSUPPORTED: layout.value('GhosttyClipboardWriteResult', 'UNSUPPORTED'),
    },
    search: {
      bufferSize: layout.size('GhosttySelectionBuffer'),
      ptr: layout.offset('GhosttySelectionBuffer', 'ptr'),
      cap: layout.offset('GhosttySelectionBuffer', 'cap'),
      len: layout.offset('GhosttySelectionBuffer', 'len'),
      NEEDLE: layout.value('GhosttySearchOption', 'NEEDLE'),
      SELECT_NEXT: layout.value('GhosttySearchOption', 'SELECT_NEXT'),
      SELECT_PREV: layout.value('GhosttySearchOption', 'SELECT_PREV'),
      SELECT_SCROLL: layout.value('GhosttySearchOption', 'SELECT_SCROLL'),
      SCROLL_NONE: layout.value('GhosttySearchScroll', 'NONE'),
      STATUS: layout.value('GhosttySearchData', 'STATUS'),
      TOTAL_MATCHES: layout.value('GhosttySearchData', 'TOTAL_MATCHES'),
      SELECTED_INDEX: layout.value('GhosttySearchData', 'SELECTED_INDEX'),
      SELECTED_MATCH: layout.value('GhosttySearchData', 'SELECTED_MATCH'),
      MATCHES: layout.value('GhosttySearchData', 'MATCHES'),
      COMPLETE: layout.value('GhosttySearchStatus', 'COMPLETE'),
      FEED_REQUIRED: layout.value('GhosttySearchStatus', 'FEED_REQUIRED'),
    },
    focus: {
      GAINED: layout.value('GhosttyFocusEvent', 'GAINED'),
      LOST: layout.value('GhosttyFocusEvent', 'LOST'),
    },
    result: {
      SUCCESS: layout.value('GhosttyResult', 'SUCCESS'),
      OUT_OF_SPACE: layout.value('GhosttyResult', 'OUT_OF_SPACE'),
    },
  };
}

/** Everything the binding resolved from the manifest, one sub-object per feature. */
export type OfficialLayout = ReturnType<typeof resolveOfficialLayout>;

// The parts of the layout each feature of the binding reads, so a binding split out of
// `OfficialTerminal` (ADR 061) declares exactly the tables it depends on.

/** Render state refresh, row and cell decoding, and scrollback pages. */
export type RenderStateLayout = Pick<
  OfficialLayout,
  | 'rs'
  | 'dirty'
  | 'row'
  | 'cellData'
  | 'cell'
  | 'tag'
  | 'wide'
  | 'styleColor'
  | 'style'
  | 'cursor'
  | 'cursorStyle'
  | 'colors'
  | 'cellsView'
  | 'cellSize'
  | 'scroll'
>;

/** Grid and screen refs, wrapped rows, hyperlinks and the title. */
export type GridRefLayout = Pick<
  OfficialLayout,
  'point' | 'gridRef' | 'rowWrapContinuation' | 'string' | 'tdata' | 'result'
>;

/** Word, line and output selection and the selection text. */
export type SelectionLayout = Pick<OfficialLayout, 'selection' | 'point' | 'gridRef' | 'string'>;

/** Ghostty's search and its matches. */
export type SearchLayout = Pick<OfficialLayout, 'search' | 'selection' | 'string' | 'result'>;

/** The mouse encoder. */
export type MouseLayout = Pick<OfficialLayout, 'mouse'>;

/** The paste and focus encoders. */
export type PasteFocusLayout = Pick<OfficialLayout, 'paste' | 'focus' | 'string'>;

/** The terminal callbacks and their payloads: replies, device attributes, effects. */
export type EffectsLayout = Pick<
  OfficialLayout,
  'opt' | 'da' | 'sizeReport' | 'notification' | 'clipboardWrite' | 'string' | 'tdata'
>;

/** Creation config, modes, colours and the default cursor. */
export type EngineConfigLayout = Pick<
  OfficialLayout,
  'opt' | 'tdata' | 'mode' | 'colors' | 'defaultCursorStyle' | 'screenAlternate' | 'scrollbar'
>;
