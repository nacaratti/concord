-- Cada envio autorizado (URL pré-assinada emitida). Vira anexo quando entra numa mensagem (used = true),
-- e só pode entrar numa mensagem do mesmo autor e do mesmo canal.
CREATE TABLE uploads (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  filename   TEXT NOT NULL,
  size       BIGINT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX uploads_unused ON uploads (id) WHERE NOT used;
