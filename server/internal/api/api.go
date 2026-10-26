// Package api expõe as rotas REST: ações e leituras. Toda escrita que outros precisam ver
// é gravada no banco e em seguida publicada no gateway.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"concord/internal/auth"
	"concord/internal/gateway"
	"concord/internal/snowflake"
	"concord/internal/store"
)

type ID = snowflake.ID

type API struct {
	Store *store.Store
	Hub   *gateway.Hub
	IDs   *snowflake.Generator
	Log   *slog.Logger
}

type ctxKey struct{}

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", a.register)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.HandleFunc("POST /api/auth/logout", a.authed(a.logout))
	mux.HandleFunc("GET /api/users/@me", a.authed(a.me))

	mux.HandleFunc("POST /api/guilds", a.authed(a.createGuild))
	mux.HandleFunc("POST /api/guilds/{guild}/channels", a.authed(a.createChannel))
	mux.HandleFunc("POST /api/guilds/{guild}/invites", a.authed(a.createInvite))
	mux.HandleFunc("GET /api/invites/{code}", a.getInvite)
	mux.HandleFunc("POST /api/invites/{code}", a.authed(a.acceptInvite))

	mux.HandleFunc("GET /api/channels/{channel}/messages", a.authed(a.listMessages))
	mux.HandleFunc("POST /api/channels/{channel}/messages", a.authed(a.sendMessage))
	mux.HandleFunc("PATCH /api/channels/{channel}/messages/{message}", a.authed(a.editMessage))
	mux.HandleFunc("DELETE /api/channels/{channel}/messages/{message}", a.authed(a.deleteMessage))
	mux.HandleFunc("POST /api/channels/{channel}/typing", a.authed(a.typing))
	return mux
}

// ---- helpers ----

type apiError struct {
	Status  int    `json:"-"`
	Message string `json:"message"`
}

func (e apiError) Error() string { return e.Message }

func errStatus(status int, msg string) error { return apiError{status, msg} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *API) fail(w http.ResponseWriter, err error) {
	var ae apiError
	switch {
	case errors.As(err, &ae):
		writeJSON(w, ae.Status, ae)
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, apiError{Message: "não encontrado"})
	case errors.Is(err, store.ErrInvite):
		writeJSON(w, http.StatusNotFound, apiError{Message: err.Error()})
	default:
		a.Log.Error("api", "err", err)
		writeJSON(w, http.StatusInternalServerError, apiError{Message: "erro interno"})
	}
}

func decode(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return errStatus(http.StatusBadRequest, "corpo JSON inválido")
	}
	return nil
}

func pathID(r *http.Request, name string) (ID, error) {
	id, err := snowflake.Parse(r.PathValue(name))
	if err != nil {
		return 0, errStatus(http.StatusBadRequest, name+" inválido")
	}
	return id, nil
}

func userFrom(r *http.Request) store.User { return r.Context().Value(ctxKey{}).(store.User) }

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return t
	}
	return h
}

func (a *API) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := a.Store.UserBySession(r.Context(), auth.HashToken(bearer(r)))
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, apiError{Message: "não autenticado"})
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	}
}

// requireMember garante que o usuário participa do servidor: é a checagem que impede vazar mensagens.
func (a *API) requireMember(ctx context.Context, guildID, userID ID) error {
	ok, err := a.Store.IsMember(ctx, guildID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return errStatus(http.StatusForbidden, "você não participa deste servidor")
	}
	return nil
}

func (a *API) textChannelFor(r *http.Request, u store.User) (store.Channel, error) {
	cid, err := pathID(r, "channel")
	if err != nil {
		return store.Channel{}, err
	}
	ch, err := a.Store.Channel(r.Context(), cid)
	if err != nil {
		return ch, err
	}
	if err := a.requireMember(r.Context(), ch.GuildID, u.ID); err != nil {
		return ch, err
	}
	if ch.Kind != store.ChannelText {
		return ch, errStatus(http.StatusBadRequest, "não é um canal de texto")
	}
	return ch, nil
}

// ---- auth ----

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_.]{2,32}$`)

type authResponse struct {
	Token string     `json:"token"`
	User  store.User `json:"user"`
}

func (a *API) issueToken(ctx context.Context, u store.User) (authResponse, error) {
	token, hash, err := auth.NewToken()
	if err != nil {
		return authResponse{}, err
	}
	return authResponse{token, u}, a.Store.CreateSession(ctx, hash, u.ID)
}

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, err)
		return
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	switch {
	case !usernameRe.MatchString(in.Username):
		a.fail(w, errStatus(http.StatusBadRequest, "usuário deve ter 2 a 32 letras, números, _ ou ."))
		return
	case len(in.Password) < 8 || len(in.Password) > 128:
		a.fail(w, errStatus(http.StatusBadRequest, "a senha precisa ter de 8 a 128 caracteres"))
		return
	case utf8.RuneCountInString(in.DisplayName) > 32:
		a.fail(w, errStatus(http.StatusBadRequest, "nome de exibição muito longo"))
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		a.fail(w, err)
		return
	}
	u, err := a.Store.CreateUser(r.Context(), a.IDs.Next(), in.Username, in.DisplayName, hash)
	if errors.Is(err, store.ErrTaken) {
		a.fail(w, errStatus(http.StatusConflict, "esse nome de usuário já existe"))
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	resp, err := a.issueToken(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, err)
		return
	}
	invalid := errStatus(http.StatusUnauthorized, "usuário ou senha incorretos")
	u, hash, err := a.Store.UserByUsername(r.Context(), in.Username)
	if errors.Is(err, store.ErrNotFound) {
		a.fail(w, invalid)
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	if ok, _ := auth.VerifyPassword(in.Password, hash); !ok {
		a.fail(w, invalid)
		return
	}
	resp, err := a.issueToken(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if err := a.Store.DeleteSession(r.Context(), auth.HashToken(bearer(r))); err != nil {
		a.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) me(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, userFrom(r)) }

// ---- servidores, canais e convites ----

func cleanName(s string, max int) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || utf8.RuneCountInString(s) > max {
		return "", errStatus(http.StatusBadRequest, "nome deve ter de 1 a "+strconv.Itoa(max)+" caracteres")
	}
	return s, nil
}

// guildPayload é o que GUILD_CREATE leva: o servidor completo mais a presença dos membros.
func (a *API) guildPayload(g store.Guild) map[string]any {
	ids := make([]ID, len(g.Members))
	for i, m := range g.Members {
		ids[i] = m.User.ID
	}
	return map[string]any{"guild": g, "presences": a.Hub.Presences(ids)}
}

func (a *API) createGuild(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, err)
		return
	}
	name, err := cleanName(in.Name, 64)
	if err != nil {
		a.fail(w, err)
		return
	}
	g := store.Guild{ID: a.IDs.Next(), Name: name, OwnerID: u.ID}
	g.Channels = []store.Channel{
		{ID: a.IDs.Next(), GuildID: g.ID, Name: "geral", Kind: store.ChannelText},
		{ID: a.IDs.Next(), GuildID: g.ID, Name: "Geral", Kind: store.ChannelVoice},
	}
	if err := a.Store.CreateGuild(r.Context(), g); err != nil {
		a.fail(w, err)
		return
	}
	full, err := a.Store.Guild(r.Context(), g.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.Hub.Subscribe(u.ID, g.ID)
	a.Hub.DispatchUser(u.ID, "GUILD_CREATE", a.guildPayload(full))
	writeJSON(w, http.StatusCreated, full)
}

func (a *API) createChannel(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	gid, err := pathID(r, "guild")
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := a.requireMember(r.Context(), gid, u.ID); err != nil {
		a.fail(w, err)
		return
	}
	var in struct {
		Name string `json:"name"`
		Kind int    `json:"kind"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, err)
		return
	}
	name, err := cleanName(in.Name, 64)
	if err != nil {
		a.fail(w, err)
		return
	}
	if in.Kind != store.ChannelText && in.Kind != store.ChannelVoice {
		a.fail(w, errStatus(http.StatusBadRequest, "tipo de canal inválido"))
		return
	}
	if in.Kind == store.ChannelText {
		name = strings.ToLower(strings.Join(strings.Fields(name), "-"))
	}
	ch := store.Channel{ID: a.IDs.Next(), GuildID: gid, Name: name, Kind: in.Kind}
	if err := a.Store.CreateChannel(r.Context(), &ch); err != nil {
		a.fail(w, err)
		return
	}
	a.Hub.DispatchGuild(gid, "CHANNEL_CREATE", ch)
	writeJSON(w, http.StatusCreated, ch)
}

func (a *API) createInvite(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	gid, err := pathID(r, "guild")
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := a.requireMember(r.Context(), gid, u.ID); err != nil {
		a.fail(w, err)
		return
	}
	var in struct {
		MaxAgeSeconds int  `json:"max_age"`
		MaxUses       *int `json:"max_uses"`
	}
	if r.ContentLength > 0 {
		if err := decode(r, &in); err != nil {
			a.fail(w, err)
			return
		}
	}
	if in.MaxAgeSeconds == 0 {
		in.MaxAgeSeconds = 7 * 24 * 3600
	}
	var expires *time.Time
	if in.MaxAgeSeconds > 0 {
		t := time.Now().Add(time.Duration(in.MaxAgeSeconds) * time.Second)
		expires = &t
	}
	code := auth.RandomCode(8)
	if err := a.Store.CreateInvite(r.Context(), code, gid, u.ID, expires, in.MaxUses); err != nil {
		a.fail(w, err)
		return
	}
	inv, err := a.Store.Invite(r.Context(), code)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

func (a *API) getInvite(w http.ResponseWriter, r *http.Request) {
	inv, err := a.Store.Invite(r.Context(), r.PathValue("code"))
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inv)
}

func (a *API) acceptInvite(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	gid, joined, err := a.Store.UseInvite(r.Context(), r.PathValue("code"), u.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	g, err := a.Store.Guild(r.Context(), gid)
	if err != nil {
		a.fail(w, err)
		return
	}
	if joined {
		m, err := a.Store.Member(r.Context(), gid, u.ID)
		if err != nil {
			a.fail(w, err)
			return
		}
		a.Hub.DispatchGuild(gid, "GUILD_MEMBER_ADD", map[string]any{
			"guild_id": gid, "member": m, "presence": a.Hub.Presence(u.ID),
		})
		a.Hub.Subscribe(u.ID, gid)
		a.Hub.DispatchUser(u.ID, "GUILD_CREATE", a.guildPayload(g))
	}
	writeJSON(w, http.StatusOK, g)
}

// ---- mensagens ----

const maxMessage = 4000

func (a *API) listMessages(w http.ResponseWriter, r *http.Request) {
	ch, err := a.textChannelFor(r, userFrom(r))
	if err != nil {
		a.fail(w, err)
		return
	}
	before := ID(1<<63 - 1)
	if b := r.URL.Query().Get("before"); b != "" {
		if before, err = snowflake.Parse(b); err != nil {
			a.fail(w, errStatus(http.StatusBadRequest, "before inválido"))
			return
		}
	}
	limit := 50
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}
	msgs, err := a.Store.Messages(r.Context(), ch.ID, before, limit)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

func validContent(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || utf8.RuneCountInString(s) > maxMessage {
		return "", errStatus(http.StatusBadRequest, "a mensagem deve ter de 1 a 4000 caracteres")
	}
	return s, nil
}

func (a *API) sendMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	ch, err := a.textChannelFor(r, u)
	if err != nil {
		a.fail(w, err)
		return
	}
	var in struct {
		Content string `json:"content"`
		Nonce   string `json:"nonce"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, err)
		return
	}
	content, err := validContent(in.Content)
	if err != nil {
		a.fail(w, err)
		return
	}
	if len(in.Nonce) > 64 {
		in.Nonce = ""
	}
	msg, err := a.Store.CreateMessage(r.Context(), a.IDs.Next(), ch.ID, u.ID, content)
	if err != nil {
		a.fail(w, err)
		return
	}
	// O nonce volta para o autor: é assim que o cliente troca a mensagem otimista pela real.
	msg.Nonce = in.Nonce
	a.Hub.DispatchGuild(ch.GuildID, "MESSAGE_CREATE", msg)
	writeJSON(w, http.StatusOK, msg)
}

func (a *API) ownMessage(r *http.Request, u store.User) (store.Message, error) {
	ch, err := a.textChannelFor(r, u)
	if err != nil {
		return store.Message{}, err
	}
	mid, err := pathID(r, "message")
	if err != nil {
		return store.Message{}, err
	}
	msg, err := a.Store.Message(r.Context(), mid)
	if err != nil {
		return msg, err
	}
	if msg.ChannelID != ch.ID {
		return msg, store.ErrNotFound
	}
	if msg.Author.ID != u.ID {
		return msg, errStatus(http.StatusForbidden, "só o autor pode alterar esta mensagem")
	}
	return msg, nil
}

func (a *API) editMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	msg, err := a.ownMessage(r, u)
	if err != nil {
		a.fail(w, err)
		return
	}
	var in struct {
		Content string `json:"content"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, err)
		return
	}
	content, err := validContent(in.Content)
	if err != nil {
		a.fail(w, err)
		return
	}
	updated, err := a.Store.UpdateMessage(r.Context(), msg.ID, content)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.Hub.DispatchGuild(updated.GuildID, "MESSAGE_UPDATE", updated)
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) deleteMessage(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	msg, err := a.ownMessage(r, u)
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := a.Store.DeleteMessage(r.Context(), msg.ID); err != nil {
		a.fail(w, err)
		return
	}
	a.Hub.DispatchGuild(msg.GuildID, "MESSAGE_DELETE", map[string]any{
		"id": msg.ID, "channel_id": msg.ChannelID, "guild_id": msg.GuildID,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) typing(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	ch, err := a.textChannelFor(r, u)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.Hub.DispatchGuild(ch.GuildID, "TYPING_START", map[string]any{
		"channel_id": ch.ID, "guild_id": ch.GuildID, "user_id": u.ID, "timestamp": time.Now().Unix(),
	})
	w.WriteHeader(http.StatusNoContent)
}
