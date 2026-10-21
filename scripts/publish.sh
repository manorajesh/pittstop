#!/bin/sh
# Build pitt stop and copy it into the personal site, where it's served at mano.raje.sh/pittstop/.
# The site's own build (CRA) copies public/ through untouched.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
site=${SITE:-"$here/../mano.raje.sh"}
[ -d "$site/public" ] || { echo "no site at $site (set SITE=...)" >&2; exit 1; }
cd "$here"
npm run build
rsync -a --delete dist/ "$site/public/pittstop/"
echo "copied to $site/public/pittstop/"
