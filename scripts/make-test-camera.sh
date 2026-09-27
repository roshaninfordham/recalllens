#!/usr/bin/env bash
# Builds two looping synthetic "camera" videos for the end-to-end run: a room photo with an intact charger on the
# Hall / Back Table zone (normal.mjpeg), and the same spot with a broken USB-C cable (damaged.mjpeg).
# Chromium plays them as a webcam via --use-file-for-fake-video-capture. Photos: Wikimedia Commons (see README).
set -euo pipefail
OUT="${1:-.e2e}"
mkdir -p "$OUT"
cd "$OUT"
UA="Mozilla/5.0 recalllens-e2e"
fetch() { [ -s "$2" ] || curl -sfL -m 60 -A "$UA" -o "$2" "https://commons.wikimedia.org/wiki/Special:FilePath/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1")?width=1280"; }
fetch "Newark Park Buff Room Ozleworth Gloucestershire England.jpg" room.jpg
fetch "Apple USB-C (USB Type C) 87W Power Adapter for MacBook Pro (48979218053).jpg" charger.jpg
fetch "Broken USB Type-C Cable.jpg" broken.jpg
scene() {
  ffmpeg -loglevel error -y -i room.jpg -i "$1" -filter_complex \
    "[0]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720[bg];[1]scale=380:285:force_original_aspect_ratio=increase,crop=380:285[fg];[bg][fg]overlay=820:390" \
    -frames:v 1 "$2"
}
scene charger.jpg scene_normal.jpg
scene broken.jpg scene_damaged.jpg
for name in normal damaged; do
  ffmpeg -loglevel error -y -loop 1 -t 10 -framerate 5 -i "scene_$name.jpg" -r 5 -q:v 5 -f mjpeg "$name.mjpeg"
done
rm -f camera.mjpeg
echo "$PWD"
