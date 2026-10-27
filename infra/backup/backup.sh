#!/bin/sh
# Backup do Postgres: um pg_dump no formato custom (-Fc, comprimido e restaurável tabela a tabela)
# logo ao subir e depois a cada BACKUP_INTERVAL_HOURS. Mantém BACKUP_KEEP_DAYS dias de arquivos.
set -eu

: "${BACKUP_INTERVAL_HOURS:=6}"
: "${BACKUP_KEEP_DAYS:=7}"
OUT=/backups

until pg_isready -q; do sleep 2; done

while true; do
  name="concord-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # Escreve num .tmp e só renomeia no fim: um backup pela metade nunca parece um backup válido.
  if pg_dump -Fc -f "$OUT/$name.tmp" && mv "$OUT/$name.tmp" "$OUT/$name"; then
    echo "backup ok: $name ($(du -h "$OUT/$name" | cut -f1))"
  else
    echo "backup FALHOU" >&2
    rm -f "$OUT/$name.tmp"
  fi
  find "$OUT" -name 'concord-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -print -delete
  sleep $((BACKUP_INTERVAL_HOURS * 3600))
done
