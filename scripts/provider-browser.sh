#!/usr/bin/env bash
# dukascopy-node 1.51 uses Playwright's default sandbox=false. Remove its
# disabling flags, preserving Chromium's sandbox. Never retry without it.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
provider_browser="${DUKASCOPY_CHROME_PATH:-$(node -p 'require("node:module").createRequire(require.resolve("dukascopy-node"))("playwright-core").chromium.executablePath()')}"
provider_args=()
for arg in "$@"; do
  case "$arg" in --no-sandbox|--disable-setuid-sandbox) ;; *) provider_args+=("$arg");; esac
done
exec "$provider_browser" "${provider_args[@]}"
