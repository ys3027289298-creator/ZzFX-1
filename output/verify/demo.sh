#!/usr/bin/env bash
# Segmented demo driver. Each section prints a title banner first so the
# recorded screen shows the segment heading.
set -e
cd "$(dirname "$0")"

title() {
    echo
    echo "############################################################"
    echo "# $1"
    echo "############################################################"
    sleep 0.6
}

title "SEGMENT 1/4  Code change: sample rate is now a parameter"
git -C ../.. diff -- ZzFX.js package.json
sleep 1

title "SEGMENT 2/4  44.1k output stays bit-identical (golden regression)"
node golden.mjs
node check-identity.mjs
sleep 1

title "SEGMENT 3/4  Same sound at 44.1k vs 48k: duration and pitch match"
node cross-rate.mjs
sleep 1

title "SEGMENT 4/4  Render timing at 44.1k vs 48k (plus wav export)"
node wav-export.mjs
node benchmark.mjs
echo
echo "All segments complete. Artifacts in output/ (wav/, render/, REPORT.md)."
sleep 1
