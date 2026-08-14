#!/bin/sh
# Refresh the vendored copies of plaza and mirador.
#
# Vendoring rather than loading from a CDN is deliberate: a call app that stops
# working because someone else's CDN had a bad afternoon is not acceptable, and
# the whole point of this stack is that nothing outside it has to be up.
#
# During active development, point the import map at ../plaza/src/ and
# ../mirador/src/ instead and skip this entirely.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
libs=${LIBS_DIR:-$(cd "$here/.." && pwd)}

for lib in plaza mirador; do
  src="$libs/$lib"
  [ -d "$src" ] || { echo "missing $src — set LIBS_DIR to where the libraries live"; exit 1; }

  rm -rf "$here/vendor/$lib"
  mkdir -p "$here/vendor/$lib"
  cp -R "$src/src" "$here/vendor/$lib/src"
  [ -d "$src/vendor" ] && cp -R "$src/vendor" "$here/vendor/$lib/vendor"

  version=$(sed -n "s/.*VERSION = '\\([^']*\\)'.*/\\1/p" "$src/src/$lib.js" | head -1)
  echo "$lib $version" >> "$here/vendor/VERSIONS"
done
