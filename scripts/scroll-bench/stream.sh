#!/usr/bin/env bash
# Streams output on the normal screen for the scroll benchmark's stream test: numbered
# lines at a steady rate, with an inverse-video status bar always on the last line. The
# bar is the only bright full-width row, so a recorded frame that shows it is at the
# bottom of the output, and one that does not is scrolled back (metrics.ts atBottom).
#
#   bash scripts/scroll-bench/stream.sh [lines-per-second] [seconds]   (default 40, 120)

rate=${1:-40}
seconds=${2:-120}
cols=$(tput cols 2>/dev/null || echo 80)
delay=$(awk "BEGIN { printf \"%.4f\", 1 / $rate }")
total=$((rate * seconds))

text='the quick brown fox jumps over the lazy dog while the slow cat sleeps'

bar() {
  printf '\e[7m%-*s\e[0m' "$cols" " stream $1/$total  ${rate} lines/s"
}

for ((i = 1; i <= total; i++)); do
  # Replace the bar with the next line, then draw the bar below it again.
  # Lines of varying length, so a frame moved by a line does not look like the one before
  printf '\r\e[2K%06d  %s\n' "$i" "${text:0:$((i * 37 % 50 + 8))}"
  bar "$i"
  sleep "$delay"
done
printf '\r\e[2K'
