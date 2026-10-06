#!/usr/bin/env bash
set -euo pipefail
local_app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo 'يحتاج التطبيق Node.js 18 أو أحدث'; exit 1; }
node "$local_app_dir/server.cjs" &
local_server_pid=$!
trap 'kill "$local_server_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  kill -0 "$local_server_pid" 2>/dev/null || { echo 'تعذر تشغيل الخادم المحلي؛ تأكد من أن المنفذ 3210 غير مستخدم'; exit 1; }
  if node -e "fetch('http://127.0.0.1:3210/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 0.1
done
for local_browser in google-chrome chromium chromium-browser; do
  if command -v "$local_browser" >/dev/null; then
    "$local_browser" --kiosk-printing --app='http://127.0.0.1:3210/' &
    echo 'التطبيق المحلي يعمل. أبق هذه الطرفية مفتوحة. Ctrl+C لإيقافه.'
    wait "$local_server_pid"
    exit
  fi
done
xdg-open 'http://127.0.0.1:3210/' || true
echo 'افتح http://127.0.0.1:3210/ — Ctrl+C لإيقاف الخادم'
wait "$local_server_pid"
