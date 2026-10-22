#!/usr/bin/env bash
# One-shot local gate: the same checks CI runs.
# Lint -> typecheck -> build -> tests. Client tests additionally resolve the
# dsh harness sources through DSH_HARNESS_ROOT (see AGENTS.md).
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test
