#!/usr/bin/env bash
set -euo pipefail

# k6 runs inside Docker; "localhost" / "127.0.0.1" in API_URL refer to the container, not the host.
# GitHub Actions often sets API_URL=http://localhost:3000 — rewrite so traffic reaches the app on the runner.
if [[ "${API_URL:-}" =~ ^https?://(localhost|127\.0\.0\.1)(:([0-9]+))?(/|$) ]]; then
  PORT="${BASH_REMATCH[3]:-3000}"
  export API_URL="http://host.docker.internal:${PORT}"
fi
export API_URL="${API_URL:-http://host.docker.internal:3000}"

mkdir -p artifacts

exec docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --add-host=host.docker.internal:host-gateway \
  -e "API_URL=${API_URL}" \
  -v "$PWD:/work" \
  -w /work \
  grafana/k6:latest run \
  --out json=artifacts/k6-results.json \
  loadtests/propchain-loadtest.js
