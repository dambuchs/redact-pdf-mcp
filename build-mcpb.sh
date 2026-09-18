#!/usr/bin/env bash
# Build the MCPB bundle (redact-pdf-mcp.mcpb) for Smithery and MCP-bundle clients.
#
# An MCPB bundle runs standalone: the client unpacks it and executes it directly,
# with no npm install step. So unlike the npm package, this one must VENDOR its
# runtime dependencies. That is the whole reason this is a separate artifact and
# not just the tarball.
#
# Rebuild on every release; the version in manifest.json must match package.json.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$(mktemp -d)"
OUT="${1:-$SRC/redact-pdf-mcp.mcpb}"
trap 'rm -rf "$STAGE"' EXIT

pkg_version=$(node -p "require('$SRC/package.json').version")
man_version=$(node -p "require('$SRC/manifest.json').version")
if [ "$pkg_version" != "$man_version" ]; then
  echo "Version mismatch: package.json=$pkg_version manifest.json=$man_version" >&2
  exit 1
fi

echo "Building redact-pdf-mcp $pkg_version"
(cd "$SRC" && npm run build >/dev/null)

cp -R "$SRC/dist" "$STAGE/dist"
cp "$SRC/manifest.json" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/README.md" "$SRC/LICENSE" "$SRC/icon.png" "$STAGE/"

# Runtime dependencies only. --ignore-scripts because nothing here needs a
# lifecycle script, and a bundle that runs one on a user's machine is a
# needless supply-chain surface.
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1)

npx -y @anthropic-ai/mcpb@2.1.2 validate "$STAGE/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$OUT"

echo
echo "Built: $OUT"
npx -y @anthropic-ai/mcpb@2.1.2 info "$OUT" 2>/dev/null | head -20

echo
echo "Publish to Smithery with:"
echo "  npx -y @smithery/cli mcp publish $OUT \\"
echo "    -n dambuchs/redact-pdf-mcp \\"
echo "    --config-schema $SRC/smithery-config-schema.json"
