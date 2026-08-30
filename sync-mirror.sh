#!/usr/bin/env bash
# Sync this package into the public mirror repo (dambuchs/redact-pdf-mcp).
#
# The mirror is a separate git repository, so `git pull` there does NOT bring
# changes from caviard-doc. Twice now the two have drifted: mirror-only edits
# were silently reverted by a --delete sync, including the .gitignore rule that
# keeps an npm token out of a public repo.
#
# Rule: this package is the single source of truth. Never edit the mirror by
# hand; change it here and run this.
set -euo pipefail

MIRROR="${1:-/tmp/redact-pdf-mcp}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$MIRROR/.git" ] || { echo "No git repo at $MIRROR" >&2; exit 1; }

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude '*.tgz' --exclude .npmrc --exclude '.env*' \
  "$SRC"/ "$MIRROR"/

echo "Synced $SRC -> $MIRROR"
git -C "$MIRROR" status --short
echo
echo "Review the diff, then:  git -C $MIRROR add -A && git -C $MIRROR commit && git -C $MIRROR push"
