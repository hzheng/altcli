#!/bin/sh
# Thin wrapper so a hook command registered as this .sh keeps working; the logic lives in codercrew-turn-complete.mjs.
# Finds a node binary even when the CLI's environment lacks nvm's PATH. Exits 0 always.
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${CODERCREW_NODE:-}"
[ -n "$NODE" ] || NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE="$c"; done
fi
[ -n "$NODE" ] || exit 0
exec "$NODE" "$DIR/codercrew-turn-complete.mjs" "$@"
