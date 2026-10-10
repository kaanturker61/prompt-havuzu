#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js bulunamadi. https://nodejs.org adresinden kurup tekrar dene."
  exit 1
fi
exec node tools/ui/server.js --open
