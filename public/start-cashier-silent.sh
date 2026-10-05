#!/usr/bin/env bash
set -eu
# Close Chrome first and set the thermal printer as the system default.
# Reuse the existing profile so company data and pending invoices remain available.
for cashier_browser in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$cashier_browser" >/dev/null 2>&1; then
    exec "$cashier_browser" --kiosk-printing --app='https://almahasibpro.onrender.com/market-cashier.html?mode=market'
  fi
done
printf '%s\n' 'Chrome or Chromium is required.' >&2
exit 1
