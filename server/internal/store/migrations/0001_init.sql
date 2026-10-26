CREATE TABLE users (
  id            BIGINT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  avatar_key    TEXT
);

CREATE TABLE sessions (
  token_hash BYTEA PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guilds (
  id       BIGINT PRIMARY KEY,
  name     TEXT NOT NULL,
  owner_id BIGINT NOT NULL REFERENCES users(id)
);

CREATE TABLE members (
  guild_id  BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE channels (
  id       BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  kind     SMALLINT NOT NULL,  -- 0 = texto, 1 = voz
  position INT NOT NULL DEFAULT 0
);
CREATE INDEX channels_guild ON channels (guild_id);

CREATE TABLE messages (
  id          BIGINT PRIMARY KEY,
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   BIGINT NOT NULL REFERENCES users(id),
  content     TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]',
  edited_at   TIMESTAMPTZ
);
CREATE INDEX messages_channel_id ON messages (channel_id, id DESC);

CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  max_uses   INT,
  uses       INT NOT NULL DEFAULT 0
);

CREATE TABLE read_states (
  user_id      BIGINT REFERENCES users(id) ON DELETE CASCADE,
  channel_id   BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
