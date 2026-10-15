# SPEC: Scroll Benchmark

**Last Updated:** 2026-10-15

---

## Description

The reference test for how scrolling looks in webtty: real apps in real sessions, scrolled with a trackpad, a mouse wheel and a TrackPoint, in a headless Chrome whose every presented frame is recorded and reduced to numbers. It compares builds side by side, so a change to scrolling, painting, the wheel or the output path is measured against the build before it, not judged by eye.

**Persona:** webtty developers changing the client's scroll, paint, wheel or write paths (the smooth scroll, ADR 040–045; the kept view, ADR 066; synchronized output, ADR 067).

It answers three questions for each app and input device:

- **Does it blink?** A frame that shows something no clean scroll could: a half-drawn screen, images gone for a frame.
- **How smooth is it?** Paints per second while scrolling, the gaps between paints, and how far the view moves per frame.
- **Does the view stay put?** Scrolled back while output streams, does the view stay on its text or get pulled to the bottom?

[ADR 068](../adrs/068.scroll-benchmark.app-modes-and-scroll-behaviour.md) records the decisions taken from its results.

## How it works

```
 Chrome (headless or not, --remote-debugging-port=9333)
   │  CDP: navigate, type, Input.dispatchMouseEvent (mouseWheel), Page.startScreencast
   ▼
 scripts/scroll-bench/bench.ts ──► POST /api/sessions {"id"}  ┐  one fresh session per
   for each scenario, input, run,     open /s/:id, type the     │  measurement, on each
   and each build (--base)            command, wait             │  server under test
                                  ──► play the input, record    │
                                      frames + paint counter    │
                                  ──► DELETE /api/sessions/:id ┘
   ▼
 one JSON line per measurement, then a markdown table of the medians over the runs
```

| Module | Role |
|--------|------|
| `bench.ts` | Entry (`bun run bench:scroll`): the loop over scenarios, inputs, runs and builds; rotates which build goes first each run; reruns a scroll in which nothing moved |
| `bench-args.ts` | The command line, checked without side effects |
| `cdp.ts` | A minimal DevTools Protocol driver for a Chrome you started; every call times out |
| `screencast.ts` | Records every presented frame as a JPEG at the page's own size |
| `inputs.ts` | The input profiles as data, and playing one as wheel events |
| `scenarios.ts` | Reads a scenarios JSON file of your own |
| `measure.ts` | Starts a scenario, then one scroll or stream measurement |
| `page.ts` | What runs in the page: the paint counter, decoding frames into row-brightness profiles |
| `metrics.ts` | Pure functions over numbers: matching frames, blinks, paints, steps, the stream counts |
| `summary.ts`, `session-api.ts`, `dump.ts` | The output, the server's session API, and saving a run's frames |
| `stream.sh` | The streaming app for the stream test |

## Running it

1. Build each webtty to compare and start it on its own port. A build before a change is a `git worktree` at that commit; a build with one change switched off is a worktree with that change neutralised. Start each server without the outer terminal's identity, so apps do not take it for that terminal:

   ```
   env -u TERM_PROGRAM -u TERM_PROGRAM_VERSION PORT=2401 bun run dist/server/index.js
   ```

2. Start Chrome with a DevTools port (the benchmark never launches one):

   ```
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
     --remote-debugging-port=9333 --user-data-dir=/tmp/scroll-bench-chrome \
     --window-size=1400,800 --no-first-run about:blank
   ```

3. Write a scenarios file (`scripts/scroll-bench/scenarios.example.json` shows every field) and run:

   ```
   bun run bench:scroll --base before=http://localhost:2401 --base after=http://localhost:2400 \
     --scenarios my-scenarios.json --inputs trackpad,wheel,trackpoint --runs 2 [--dump DIR]
   ```

   `--dump DIR` saves each run's start screenshot, every recorded frame and the indices of the frames counted as blinks, so any number can be checked against the pictures.

Commands that resume a personal pi or Claude Code session belong in your own scenarios file, not the repo. Resume Claude Code with `--fork-session` so the session is not changed. Call apps by a name the session's shell finds: a wrapper earlier on your interactive `PATH` may not be on the server's.

### Inputs

| Input | Events | What it stands for |
|-------|--------|--------------------|
| `trackpad` | 150 deltas of 2.5 px, 16 ms apart | A slow two-finger scroll: a small delta every frame |
| `wheel` | 14 notches of 100 px, 100–120 ms apart | A mouse wheel spun by hand, as Chromium on macOS reports a notch |
| `trackpoint` | 8 light 4.000244 px steps ~150 ms apart, then, after a 300 ms pause, a hard push of 15 fractional deltas up to 334.75 px, 29–45 ms apart | ADR 045's TrackPoint capture: its light step, its peak and its gaps (the push's ramp is synthetic) |

### Scenarios measured

| Scenario | Screen | Who scrolls | Command (in the reference run) |
|----------|--------|-------------|--------------------------------|
| pi fullscreen | alternate | pi, by lines | `pi -r`, first session (277 messages, an image) |
| pi classic | normal | webtty's scrollback | `pi --tui-mode regular -r` |
| Claude Code fullscreen | alternate | Claude Code, by lines | `CLAUDE_CODE_NO_FLICKER=1 claude --resume <4.3 MB session> --fork-session` |
| Claude Code classic | normal | webtty's scrollback | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --resume … --fork-session` |
| vim, nvim | alternate | the editor (mouse on) | a 20,000-line file whose lines differ in length |
| yazi | alternate | yazi (mouse on) | `yazi`, the pointer over the file list (`pointer` field) |
| less | alternate | less, by arrow keys | `seq 1 20000 \| less` |
| seq | normal | webtty's scrollback | `seq 1 5000` |
| stream | normal | webtty's scrollback | `stream.sh 40 120`: 40 lines a second under an inverse status bar |

## Measures

- **Frames** come from `Page.startScreencast` at the page's own size, each reduced to a profile: the mean of the red and green channels of each pixel row, over 600 px from x = 8. Two frames *match* at the vertical shift with the least mean row error, searched within ±60, ±150 or ±240 px for the trackpad, the wheel and the TrackPoint; an error above 3 is a different picture.
- **Blink**: a frame that is a different picture from both neighbours at any shift, while the neighbours match each other (error ≤ 3 and under half the smaller of the two). Smooth motion never counts, nor do three frames that all differ (an app redrawing); a half-drawn or flashed frame does. Calibrated at 0 on `seq`; while building the harness, blinks were checked in their saved frames (`--dump`), which showed real torn frames in pi and Claude Code fullscreen and the false hits the pitfalls below now guard against.
- **Paints/s, gap p50/p90**: from a counter in the page that flags each animation frame in which the canvas was drawn, between the first wheel event and 400 ms after the last.
- **Step px**: the mean shift of the frames that moved and still matched. In a fullscreen app it is the app's own step (a line is 14 px).
- **Stream test**: frames showing `stream.sh`'s bar are at the bottom, read from the red channel over 400 px from x = 8. It counts them while scrolling back and at rest after, and counts at-rest frames that moved or changed.

### Pitfalls the harness guards against

| Pitfall | Effect | Guard |
|---------|--------|-------|
| Recording smaller than the page | A smooth step becomes a fractional shift; the resampling blur on high-contrast text reads as blinks | Record at `innerWidth × devicePixelRatio` |
| Lines that look alike | A frame moved by a line matches the one before; motion reads as 0 | Test files and `stream.sh` vary their line lengths |
| A brightness test over the whole row | `stream.sh` sizes its bar with `tput cols`, which can be narrower than the page (80 columns in the reference sessions): averaged over 1400 px it is too dim | The stream test reads the left 400 px, under the bar in any terminal 50 columns wide |
| The wheel over the wrong pane | yazi scrolls the pane under the pointer (its preview, at the centre) | A scenario's `pointer` field |
| Typing before the shell's prompt | The command is lost; nothing moves | A 1.5 s wait, and a scroll in which nothing moved runs again (`# retried` on stderr) |
| Apps left running after a session is deleted | Hundreds of leaked processes load the machine | Fixed in the server: deleting a session hangs up its shell (SIGHUP) |

## Reference results

Run on 2026-10-15 in headless Chrome 151 (1400×657, DPR 1) on macOS, two runs each, medians shown. Four builds of this branch: **none** (`58ea652`, before ADR 066 and 067, with the server's SIGHUP fix of `ede827a` applied so sessions do not leak), **066** and **067** (`2886492` with the other fix switched off), and **both** (`2886492`). Spotlight indexing loaded the machine during part of the run. Paints per second of apps that scroll by lines moved noticeably between this and two earlier runs of the day, so compare builds within one run; the blink and stream counts held steady.

**Blinks per run** (trackpad / wheel / TrackPoint):

| Scenario | none | 066 | 067 | both |
|----------|------|-----|-----|------|
| pi fullscreen | 1 / 1 / 1.5 | 6.5 / 1 / 1 | 0 / 0 / 0 | **0 / 0 / 0** |
| Claude Code fullscreen | 0.5 / 6 / 0.5 | 0 / 7.5 / 1.5 | 0 / 0 / 0.5 | **0 / 0 / 0** |
| pi classic, Claude Code classic, vim, nvim, yazi, less, seq | 0 | 0 | 0 | 0 |

**Paints per second, build "both"** (trackpad / wheel / TrackPoint), with the step per frame:

| Scenario | Paints/s | Step |
|----------|----------|------|
| pi classic, Claude Code classic, seq | 111 / 67 / 61 | 1.5 / 13 / 31 px: webtty's pixel-smooth scrollback |
| pi fullscreen | 11 / 45 / 18 | 14 / 17 / 72 px: pi's lines |
| Claude Code fullscreen | 11 / 43 / 9.5 | 14 / 78 / 65 px: Claude Code's lines |
| vim, nvim | 11 / 51 / 19 and 9 / 45 / 17 | 3 lines a tick (42 px with a trackpad) |
| yazi, less | 17 / 53 / 21 and 10 / 51 / 24 | — |

Classic modes scroll about ten times as often as fullscreen ones with a trackpad, by pixels instead of lines. Within a mode the four builds paint alike, except where ADR 067 holds frames during an app's updates: Claude Code fullscreen with the wheel paints 43/s with both fixes against 56/s before, every paint now a complete update: the paints it drops are the torn frames (6 a run before) and other in-between states.

**Stream test** (frames at the bottom while scrolling back / frames at the bottom at rest / at-rest frames that moved):

| Input | none | 066 | 067 | both |
|-------|------|-----|-----|------|
| trackpad | 277.5 of 277.5 / 46.5 of 47 / 45 | 12 of 300 / 0 of 85.5 / 0 | 293 of 295 / 87 of 87.5 / 47 | **13.5 of 295 / 0 of 85 / 0** |
| wheel | 114.5 of 131 / 88 of 88 / 46.5 | 15 of 131.5 / 0 of 90 / 0 | 109.5 of 131.5 / 88.5 of 89 / 47.5 | **14 of 131.5 / 0 of 89 / 0** |
| TrackPoint | 104.5 of 127.5 / 86.5 of 86.5 / 46.5 | 17.5 of 155.5 / 0 of 88 / 0 | 138.5 of 167.5 / 87.5 of 88 / 46 | **18 of 156 / 0 of 87 / 0** |

Without ADR 066 the view is pulled back to the bottom on almost every frame; with it, only the frames before the scroll leaves the bottom show it.

**Back-to-back updates.** Claude Code fullscreen, scrolled hard with a TrackPoint, sends synchronized updates of 5 ms on the wire (median; 36 ms at most) 1 ms apart, traced over CDP. In a run before the reference run, painting only on frames that find the mode off dropped it to 7 paints/s with 380 ms between paints at p90. With an update painted as it ends after a held frame (ADR 067), the reference run gives 9.1 (067) and 9.5 (both) paints/s with 417 and 267 ms at p90, against 12.1–12.7 and 188–204 ms without the hold, and no torn frames: better than before, still a cost of the hold for this input.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Harness | `scripts/scroll-bench`: input profiles, scenarios file, recorded frames, blink/paint/step/stream measures, builds compared side by side, `--dump` | [ADR 068](../adrs/068.scroll-benchmark.app-modes-and-scroll-behaviour.md) | ✅ |
| Reference results | Four builds × ten scenarios × three inputs, 2026-10-15 | [ADR 068](../adrs/068.scroll-benchmark.app-modes-and-scroll-behaviour.md) | ✅ |
| Real display | The same scenarios on a physical display and input devices, beside the headless numbers | — | ⬜ |
