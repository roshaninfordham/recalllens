#!/usr/bin/env bash
# Serves the in-browser object detector locally (no CDN at runtime, so venue Wi-Fi can't break it).
# Copies MediaPipe's wasm runtime from node_modules and downloads the EfficientDet-Lite model once.
set -euo pipefail
DEST=public/mediapipe
mkdir -p "$DEST/wasm"
SRC=node_modules/@mediapipe/tasks-vision
cp -f "$SRC"/wasm/vision_wasm_internal.{js,wasm} "$DEST/wasm/"
cp -f "$SRC/vision_bundle.js" "$DEST/"
for m in efficientdet_lite0 efficientdet_lite2; do
  f="$DEST/$m.tflite"
  [ -s "$f" ] || curl -sfL -m 120 -o "$f" "https://storage.googleapis.com/mediapipe-models/object_detector/$m/float16/latest/$m.tflite"
done
ls -la "$DEST" | awk '{print $5, $9}' | tail -n +2
