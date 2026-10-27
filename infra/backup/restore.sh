#!/bin/sh
# Restaura um backup num banco. Uso (de dentro de infra/):
#   docker compose run --rm backup restore.sh backups/concord-AAAAMMDDTHHMMSSZ.dump [banco]
# Sem [banco], restaura no "concord" (apaga e recria os objetos). Para testar sem mexer
# no banco principal, passe outro nome, ex.: concord_restore.
set -eu

file="${1:?informe o arquivo .dump}"
db="${2:-concord}"
case "$file" in /*) ;; *) file="/$file" ;; esac

until pg_isready -q; do sleep 1; done
if [ "$db" != "concord" ]; then
  dropdb --if-exists "$db"
  createdb "$db"
fi
# --clean --if-exists: troca o conteúdo atual pelo do backup; --no-owner: não depende dos usuários originais.
pg_restore --clean --if-exists --no-owner -d "$db" "$file"
echo "restaurado $file em $db"
