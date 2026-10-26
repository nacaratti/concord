// Package store concentra todo o acesso ao PostgreSQL.
package store

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"regexp"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"concord/internal/snowflake"
)

type ID = snowflake.ID

var (
	ErrNotFound = errors.New("não encontrado")
	ErrTaken    = errors.New("já existe")
	ErrInvite   = errors.New("convite inválido ou expirado")
)

const (
	ChannelText  = 0
	ChannelVoice = 1
)

type User struct {
	ID          ID      `json:"id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	AvatarKey   *string `json:"avatar_key"`
}

type Channel struct {
	ID            ID     `json:"id"`
	GuildID       ID     `json:"guild_id"`
	Name          string `json:"name"`
	Kind          int    `json:"kind"`
	Position      int    `json:"position"`
	LastMessageID *ID    `json:"last_message_id"`
}

// ReadState é até onde o usuário leu um canal, e quantas menções a ele chegaram depois disso.
type ReadState struct {
	ChannelID    ID  `json:"channel_id"`
	LastReadID   ID  `json:"last_read_id"`
	MentionCount int `json:"mention_count"`
}

type Member struct {
	User     User      `json:"user"`
	Nickname *string   `json:"nickname"`
	JoinedAt time.Time `json:"joined_at"`
}

type Guild struct {
	ID       ID        `json:"id"`
	Name     string    `json:"name"`
	OwnerID  ID        `json:"owner_id"`
	Channels []Channel `json:"channels"`
	Members  []Member  `json:"members"`
}

type Message struct {
	ID        ID         `json:"id"`
	ChannelID ID         `json:"channel_id"`
	GuildID   ID         `json:"guild_id"`
	Author    User       `json:"author"`
	Content   string     `json:"content"`
	EditedAt  *time.Time `json:"edited_at"`
	Timestamp time.Time  `json:"timestamp"`
	Nonce     string     `json:"nonce,omitempty"`
}

type Invite struct {
	Code      string     `json:"code"`
	GuildID   ID         `json:"guild_id"`
	GuildName string     `json:"guild_name"`
	ExpiresAt *time.Time `json:"expires_at"`
	MaxUses   *int       `json:"max_uses"`
	Uses      int        `json:"uses"`
}

type Store struct{ DB *pgxpool.Pool }

//go:embed migrations/*.sql
var migrations embed.FS

func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, err
	}
	return &Store{DB: pool}, nil
}

// Migrate aplica, em ordem, os arquivos de migrations/ que ainda não rodaram.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.DB.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		var done bool
		if err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, name).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, _ := migrations.ReadFile(name)
		err := pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name)
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func isUnique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

const userCols = `u.id, u.username, COALESCE(u.display_name, u.username), u.avatar_key`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarKey)
	return u, err
}

// ---- usuários e sessões ----

func (s *Store) CreateUser(ctx context.Context, id ID, username, displayName, hash string) (User, error) {
	var dn *string
	if displayName != "" {
		dn = &displayName
	}
	_, err := s.DB.Exec(ctx, `INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
		id, username, dn, hash)
	if isUnique(err) {
		return User{}, ErrTaken
	}
	if err != nil {
		return User{}, err
	}
	if displayName == "" {
		displayName = username
	}
	return User{ID: id, Username: username, DisplayName: displayName}, nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, string, error) {
	var u User
	var hash string
	err := s.DB.QueryRow(ctx, `SELECT `+userCols+`, u.password_hash FROM users u WHERE lower(u.username) = lower($1)`, username).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarKey, &hash)
	return u, hash, notFound(err)
}

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, userID ID) error {
	_, err := s.DB.Exec(ctx, `INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)`, tokenHash, userID)
	return err
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

func (s *Store) UserBySession(ctx context.Context, tokenHash []byte) (User, error) {
	u, err := scanUser(s.DB.QueryRow(ctx, `SELECT `+userCols+` FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, tokenHash))
	return u, notFound(err)
}

// ---- servidores (guilds) ----

func (s *Store) CreateGuild(ctx context.Context, g Guild) error {
	return pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)`, g.ID, g.Name, g.OwnerID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO members (guild_id, user_id) VALUES ($1, $2)`, g.ID, g.OwnerID); err != nil {
			return err
		}
		for _, c := range g.Channels {
			if _, err := tx.Exec(ctx, `INSERT INTO channels (id, guild_id, name, kind, position) VALUES ($1, $2, $3, $4, $5)`,
				c.ID, g.ID, c.Name, c.Kind, c.Position); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) GuildIDsForUser(ctx context.Context, userID ID) ([]ID, error) {
	rows, err := s.DB.Query(ctx, `SELECT guild_id FROM members WHERE user_id = $1 ORDER BY joined_at`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[ID])
}

// Guild carrega o servidor completo: canais e membros.
func (s *Store) Guild(ctx context.Context, id ID) (Guild, error) {
	var g Guild
	err := s.DB.QueryRow(ctx, `SELECT id, name, owner_id FROM guilds WHERE id = $1`, id).Scan(&g.ID, &g.Name, &g.OwnerID)
	if err != nil {
		return g, notFound(err)
	}
	// last_message_id sai do índice (channel_id, id DESC): uma leitura por canal.
	rows, err := s.DB.Query(ctx, `SELECT c.id, c.guild_id, c.name, c.kind, c.position,
		(SELECT m.id FROM messages m WHERE m.channel_id = c.id ORDER BY m.id DESC LIMIT 1)
		FROM channels c WHERE c.guild_id = $1 ORDER BY c.kind, c.position, c.id`, id)
	if err != nil {
		return g, err
	}
	g.Channels, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Channel, error) {
		var c Channel
		err := r.Scan(&c.ID, &c.GuildID, &c.Name, &c.Kind, &c.Position, &c.LastMessageID)
		return c, err
	})
	if err != nil {
		return g, err
	}
	rows, err = s.DB.Query(ctx, `SELECT `+userCols+`, m.nickname, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 ORDER BY m.joined_at`, id)
	if err != nil {
		return g, err
	}
	g.Members, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Member, error) {
		var m Member
		err := r.Scan(&m.User.ID, &m.User.Username, &m.User.DisplayName, &m.User.AvatarKey, &m.Nickname, &m.JoinedAt)
		return m, err
	})
	return g, err
}

func (s *Store) GuildsForUser(ctx context.Context, userID ID) ([]Guild, error) {
	ids, err := s.GuildIDsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	guilds := make([]Guild, 0, len(ids))
	for _, id := range ids {
		g, err := s.Guild(ctx, id)
		if err != nil {
			return nil, err
		}
		guilds = append(guilds, g)
	}
	return guilds, nil
}

func (s *Store) IsMember(ctx context.Context, guildID, userID ID) (bool, error) {
	var ok bool
	err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`, guildID, userID).Scan(&ok)
	return ok, err
}

func (s *Store) Member(ctx context.Context, guildID, userID ID) (Member, error) {
	var m Member
	err := s.DB.QueryRow(ctx, `SELECT `+userCols+`, m.nickname, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id = $2`, guildID, userID).
		Scan(&m.User.ID, &m.User.Username, &m.User.DisplayName, &m.User.AvatarKey, &m.Nickname, &m.JoinedAt)
	return m, notFound(err)
}

// ---- canais ----

func (s *Store) Channel(ctx context.Context, id ID) (Channel, error) {
	var c Channel
	err := s.DB.QueryRow(ctx, `SELECT id, guild_id, name, kind, position FROM channels WHERE id = $1`, id).
		Scan(&c.ID, &c.GuildID, &c.Name, &c.Kind, &c.Position)
	return c, notFound(err)
}

func (s *Store) CreateChannel(ctx context.Context, c *Channel) error {
	return s.DB.QueryRow(ctx, `INSERT INTO channels (id, guild_id, name, kind, position)
		VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE guild_id = $2 AND kind = $4))
		RETURNING position`, c.ID, c.GuildID, c.Name, c.Kind).Scan(&c.Position)
}

// ---- convites ----

func (s *Store) CreateInvite(ctx context.Context, code string, guildID, by ID, expiresAt *time.Time, maxUses *int) error {
	_, err := s.DB.Exec(ctx, `INSERT INTO invites (code, guild_id, created_by, expires_at, max_uses) VALUES ($1, $2, $3, $4, $5)`,
		code, guildID, by, expiresAt, maxUses)
	return err
}

func (s *Store) Invite(ctx context.Context, code string) (Invite, error) {
	var inv Invite
	err := s.DB.QueryRow(ctx, `SELECT i.code, i.guild_id, g.name, i.expires_at, i.max_uses, i.uses
		FROM invites i JOIN guilds g ON g.id = i.guild_id WHERE i.code = $1`, code).
		Scan(&inv.Code, &inv.GuildID, &inv.GuildName, &inv.ExpiresAt, &inv.MaxUses, &inv.Uses)
	if err != nil {
		return inv, notFound(err)
	}
	if (inv.ExpiresAt != nil && time.Now().After(*inv.ExpiresAt)) || (inv.MaxUses != nil && inv.Uses >= *inv.MaxUses) {
		return inv, ErrInvite
	}
	return inv, nil
}

// UseInvite adiciona o usuário ao servidor. joined=false se ele já era membro.
func (s *Store) UseInvite(ctx context.Context, code string, userID ID) (guildID ID, joined bool, err error) {
	err = pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		var expires *time.Time
		var maxUses *int
		var uses int
		err := tx.QueryRow(ctx, `SELECT guild_id, expires_at, max_uses, uses FROM invites WHERE code = $1 FOR UPDATE`, code).
			Scan(&guildID, &expires, &maxUses, &uses)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvite
		}
		if err != nil {
			return err
		}
		if (expires != nil && time.Now().After(*expires)) || (maxUses != nil && uses >= *maxUses) {
			return ErrInvite
		}
		tag, err := tx.Exec(ctx, `INSERT INTO members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, guildID, userID)
		if err != nil {
			return err
		}
		joined = tag.RowsAffected() == 1
		if joined {
			_, err = tx.Exec(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = $1`, code)
		}
		return err
	})
	return
}

// ---- mensagens ----

const messageCols = `m.id, m.channel_id, c.guild_id, ` + userCols + `, m.content, m.edited_at`

func scanMessage(row pgx.Row) (Message, error) {
	var m Message
	err := row.Scan(&m.ID, &m.ChannelID, &m.GuildID, &m.Author.ID, &m.Author.Username, &m.Author.DisplayName, &m.Author.AvatarKey, &m.Content, &m.EditedAt)
	m.Timestamp = m.ID.Time()
	return m, err
}

func (s *Store) CreateMessage(ctx context.Context, id, channelID, authorID ID, content string) (Message, error) {
	if _, err := s.DB.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, $4)`,
		id, channelID, authorID, content); err != nil {
		return Message{}, err
	}
	return s.Message(ctx, id)
}

func (s *Store) Message(ctx context.Context, id ID) (Message, error) {
	m, err := scanMessage(s.DB.QueryRow(ctx, `SELECT `+messageCols+` FROM messages m
		JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.author_id WHERE m.id = $1`, id))
	return m, notFound(err)
}

// Messages pagina por cursor: as `limit` mensagens mais novas com id < before, da mais nova para a mais antiga.
func (s *Store) Messages(ctx context.Context, channelID, before ID, limit int) ([]Message, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+messageCols+` FROM messages m
		JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.author_id
		WHERE m.channel_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT $3`, channelID, before, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Message, error) { return scanMessage(r) })
}

func (s *Store) UpdateMessage(ctx context.Context, id ID, content string) (Message, error) {
	if _, err := s.DB.Exec(ctx, `UPDATE messages SET content = $2, edited_at = now() WHERE id = $1`, id, content); err != nil {
		return Message{}, err
	}
	return s.Message(ctx, id)
}

func (s *Store) DeleteMessage(ctx context.Context, id ID) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM messages WHERE id = $1`, id)
	return err
}

// ---- estado de leitura ----

// mentionPattern casa "@usuario" como palavra inteira, no dialeto de regex do Postgres (\M = fim de palavra).
func mentionPattern(username string) string {
	return `(^|\s)@` + regexp.QuoteMeta(username) + `\M`
}

// ReadStates devolve, para cada canal de texto dos servidores do usuário, até onde ele leu
// e quantas menções a ele chegaram depois. Canal nunca lido conta como lido até o id 0.
func (s *Store) ReadStates(ctx context.Context, userID ID, username string) ([]ReadState, error) {
	rows, err := s.DB.Query(ctx, `SELECT c.id, COALESCE(rs.last_read_id, 0),
		(SELECT count(*) FROM messages m
		  WHERE m.channel_id = c.id AND m.id > COALESCE(rs.last_read_id, 0)
		    AND m.author_id <> $1 AND m.content ~* $2)
		FROM channels c
		JOIN members mb ON mb.guild_id = c.guild_id AND mb.user_id = $1
		LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1
		WHERE c.kind = $3`, userID, mentionPattern(username), ChannelText)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ReadState, error) {
		var rs ReadState
		err := r.Scan(&rs.ChannelID, &rs.LastReadID, &rs.MentionCount)
		return rs, err
	})
}

// Ack marca o canal como lido até messageID. Nunca anda para trás: devolve o valor efetivo.
func (s *Store) Ack(ctx context.Context, userID, channelID, messageID ID) (ID, error) {
	var last ID
	err := s.DB.QueryRow(ctx, `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id)
		RETURNING last_read_id`, userID, channelID, messageID).Scan(&last)
	return last, err
}
