# SPEC: Kitty Graphics

**Last Updated:** 2026-09-20

---

## Description

Display images from PTY programs using the
[kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/),
which ghostty-web's WASM core does not implement. The client intercepts the
protocol's APC sequences before they reach ghostty-web, decodes the images
itself, and draws them on an overlay canvas above the terminal canvas.

Primary target for the POC: full-window streaming apps such as
[terminal-browser](https://github.com/zenbu-labs/terminal-browser) (standalone
mode), plus `kitten icat`-style single images. See
[ADR 032](../adrs/032.client.kitty-graphics-overlay.md) for the decision and
the rejected alternatives.

## Data flow

```
PTY ──► server ──► WebSocket ──► ws.onmessage
                                    │
                        KittyGraphics.feed(data)   (src/client/kitty.ts splitter)
                          │            │
                     text segments   APC commands
                          │            │
                  term.write(text)   handle(cmd)  ──► placements table
                          ▲            │                    │
                          └─ cursor ───┘                    ▼
                          advance / reply                overlay canvas
                                                       (src/client/graphics.ts)
replies (a=q OK, CSI 14t/16t/18t) ──► ws.send ──► PTY
```

Text before an APC is written first, so the cursor position read when the
command is handled is exact.

## Protocol support

| Feature | POC |
|---------|-----|
| `a=T` transmit + display, `a=t` transmit, `a=p` place (replies `OK` when an id was given; may follow `a=t` immediately, the placement waits for the decode) | ✅ |
| `a=d` delete: `a`/`A` (all), `i`/`I` (by id, optional `p`); no reply on success, as the protocol defines none | ✅ |
| `a=q` query | ✅ |
| `t=d` direct transmission, chunked with `m=` | ✅ |
| `t=f` / `t=t` / `t=s` (file, temp file, shared memory) | ❌ answered with error so clients fall back to `t=d` |
| `f=24` RGB, `f=32` RGBA, `f=100` PNG | ✅ |
| `o=z` zlib compression | ✅ |
| `f=100` + `o=z` with `a=T` / `a=p` | ⚠️ needs `C=1`: the size is unknown until the decode, and the cursor must move at this point in the stream. Rejected with `EINVAL` otherwise; `a=t` alone and `a=p` after the decode finished are fine |
| `i` / `p` replace semantics (re-sending an image id replaces it) | ✅ |
| `C=1` cursor stays; `C=0` cursor moves past image | ✅ |
| `c`/`r` cell sizing, `x`/`y`/`w`/`h` source rect, `X`/`Y` offset | ✅ |
| `q=1` / `q=2` reply suppression | ✅ |
| Unicode placeholders (`U=1`) | ❌ |
| Animation (`a=f`, `a=a`, `a=c`) | ❌ |
| `z` layering under text | ❌ (always above) |
| Other delete targets (`d=c`, `d=p`, `d=x`, ...) | ❌ ignored |

## Replies

Written back to the PTY over the WebSocket:

- `ESC _ G i=<id>[,p=<pid>] ; OK ESC \` — success, when the command carried an
  image id (`i` or `I`) and `q` did not suppress it.
- `ESC _ G i=<id> ; E<CODE>:<message> ESC \` — failure.
- `CSI 4 ; <h> ; <w> t` (answer to `CSI 14 t`) — text-area size in pixels.
- `CSI 6 ; <ch> ; <cw> t` (answer to `CSI 16 t`) — cell size in pixels.
- `CSI 8 ; <rows> ; <cols> t` (answer to `CSI 18 t`) — text-area size in cells.

Pixel sizes are device pixels, matching what kitty and Ghostty report. The cell size is `round(cssCell × devicePixelRatio)` and the text-area size is `cols × cell`, so the numbers a program derives always agree with each other, including at fractional ratios.

## Limits

A PTY program controls what the client allocates, so each of these is checked
before the work is done, and a violation is answered with `EINVAL` and nothing
is kept:

| Limit | Value | Checked |
|-------|-------|---------|
| Encoded bytes in one transmission (all `m=1` chunks together) | 64 MiB | as chunks arrive; the rest of the chunks are swallowed |
| Bytes in one APC sequence | 64 MiB | while splitting. Only its start is kept, so the command can still be answered with `EINVAL`, and none of the payload reaches the terminal as text. Like any control string it ends at ST, or at CAN / SUB, which is the way out of one that is never terminated |
| Pixels in one image | 32M (128 MiB as RGBA) | from `s` x `v` / the PNG header before decoding, and from the header of what a compressed PNG inflates to |
| Inflated size | exactly `s x v x bytes-per-pixel` for raw pixels, 64 MiB for a PNG | while inflating, which stops early |
| Decoded bytes across all images, including decodes still running | 512 MiB | a transmission reserves its encoded payload plus its RGBA output (the worst case for a compressed PNG, whose size is unknown) before decoding starts. Stored images are dropped, oldest first, to make room; if it still does not fit the transmission is refused with `EINVAL`. After a decode, oldest images are dropped first and the newest transmission is kept |
| Images kept | 256 | on transmit; oldest dropped first |

Raw images need positive integer `s` and `v`. An uncompressed PNG's header is
checked in full (signature, a 13-byte IHDR as the first chunk, dimensions of 1
to 2^31 - 1) before its size is used to move the cursor.

## Replies to transmissions

Every transmission that carries an image id gets a reply, once its decode has
finished, unless `q` suppresses it: `OK` on success, an error on failure. That
includes one that was superseded by a newer transmission of the same id (`OK`:
it was valid) and one whose image was evicted or deleted before it finished
(`EINVAL`). The exception is a decode that was running when the stream was
reset: nobody is waiting for it any more.

A newer transmission of an id replaces the image. While it decodes, an older
one that finishes first is shown, so a stream of frames is not blank whenever
decoding lags behind; a bitmap never replaces one from a newer transmission.
Placements are sized from the latest transmission, never from a bitmap held
over from the previous one.

## Reconnect

`KittyGraphics.reset()` runs when the WebSocket opens. It discards the parser
state (a connection can drop mid-APC), drops all images and placements, and
invalidates decodes still running: a decode that finishes afterwards neither
installs its bitmap nor replies into the new stream, even if the new stream
reuses the same image id.

## Source layout

```
src/client/
  kitty.ts        ← pure: APC splitter, key=value parser, reply builders (unit tested)
  kitty.test.ts
  graphics.ts     ← browser: decode, placement table, overlay canvas, scroll tracking
  graphics.test.ts ← state handling against a stubbed DOM and image decoder
  index.ts        ← wires ws.onmessage through KittyGraphics
```

## Known limitations

- **Placements stop following the text once the scrollback is full.** A placement
  is anchored to the number of scrollback lines plus its row when it was made.
  That number stops growing when the scrollback reaches its limit (3277 lines
  with the default `scrollback`), while output keeps pushing rows off the top,
  so from then on a main-screen placement stays at its screen row instead of
  scrolling away with its text. The emulator exposes no count of rows it has
  evicted, so the client cannot correct for it. The alternate screen has no
  scrollback and is not affected. Native support in the emulator (which tracks
  positions itself) is the real fix.

- The emulator does not know images exist: text written over an image does not
  erase it. Cleared by `CSI 2 J` / `CSI 3 J`, alt-screen switch, and `ESC c`.
- Server `session.scrollback` stores raw PTY output including image payloads:
  large frames evict real text, and a reconnect replay can begin mid-APC.
  Follow-up: strip APCs from the stored scrollback.
- Device-pixel sizes mean a full-window frame on a 2x display is 4x the pixels.
  Bandwidth and decode cost are unmeasured; a Worker or a lower scale may be
  needed.
- Windows: ConPTY may filter APC sequences before they reach webtty, in which
  case graphics from Windows-side programs never arrive; not verified here.
  terminal-browser itself is macOS/Linux only.
- The scale a program uses for CSS pixels comes from its own machine's display
  (terminal-browser asks Electron), not from the browser tab. Local use on one
  display is consistent; a remote or mixed-DPI setup can still mismatch.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| APC splitter | Stateful across chunks; strips APC from text handed to ghostty-web | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Direct-transmission decode | `t=d`, `f=24/32/100`, `o=z`, chunked | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Overlay canvas + placements | Anchored to scrollback rows, cleared on screen clear / alt switch | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Query and size replies | `a=q`, `CSI 14t` / `16t` / `18t` | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| terminal-browser (standalone) works | Verified end to end in a browser tab on macOS (HiDPI) | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Scrollback APC stripping (server) | Keep image payloads out of `session.scrollback` | — | ⬜ |
| Unicode placeholders | `U=1`, needed for tmux and terminal-browser embedded mode | — | ⬜ |
