#!/usr/bin/env bash
set -euo pipefail
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export GYEOL_DEPLOY_TARGET=oracle
exec bash "$bundle_dir/install-base.sh" "$@"
