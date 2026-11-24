#!/bin/sh
# Garante que a pasta de dados (volume/disco persistente) pertença ao usuário "node"
# e executa o sistema sem privilégios de root.
set -e
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %U "$DATA_DIR")" != "node" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "[entrypoint] aviso: setpriv indisponível, executando como root" >&2
fi
exec "$@"
