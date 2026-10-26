// Package gateway mantém um WebSocket por cliente e empurra eventos em tempo real,
// seguindo o mesmo envelope {op, t, s, d} do gateway do Discord.
package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"

	"concord/internal/auth"
	"concord/internal/ratelimit"
	"concord/internal/snowflake"
	"concord/internal/store"
)

type ID = snowflake.ID

const (
	OpDispatch       = 0
	OpHeartbeat      = 1
	OpIdentify       = 2
	OpPresence       = 3
	OpResume         = 6
	OpReconnect      = 7
	OpInvalidSession = 9
	OpHello          = 10
	OpHeartbeatAck   = 11
)

const (
	HeartbeatInterval = 30 * time.Second
	ResumeWindow      = 2 * time.Minute // por quanto tempo uma sessão caída pode ser retomada
	replayBuffer      = 500             // eventos guardados por sessão para o RESUME
	outQueue          = 1024
)

// Códigos de fechamento próprios (faixa 4000-4999, como no Discord).
const (
	CloseUnknownOpcode  websocket.StatusCode = 4001
	CloseDecodeError    websocket.StatusCode = 4002
	CloseNotAuth        websocket.StatusCode = 4003
	CloseAuthFailed     websocket.StatusCode = 4004
	CloseSessionTimeout websocket.StatusCode = 4009
)

type inFrame struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
}

type outFrame struct {
	Op int    `json:"op"`
	T  string `json:"t,omitempty"`
	S  int64  `json:"s,omitempty"`
	D  any    `json:"d"`
}

type Presence struct {
	UserID   ID     `json:"user_id"`
	Status   string `json:"status"` // online, idle, dnd, offline
	Activity string `json:"activity,omitempty"`
}

// ---- conexão física ----

type conn struct {
	ws     *websocket.Conn
	out    chan []byte
	closed chan struct{}
	once   sync.Once
}

func (c *conn) send(b []byte) {
	select {
	case c.out <- b:
	case <-c.closed:
	default:
		// cliente lento demais: derruba, ele reconecta com RESUME
		go c.close(websocket.StatusPolicyViolation, "fila de saída cheia")
	}
}

func (c *conn) close(code websocket.StatusCode, reason string) {
	c.once.Do(func() {
		close(c.closed)
		_ = c.ws.Close(code, reason)
	})
}

func (c *conn) writeLoop(ctx context.Context) {
	for {
		select {
		case b := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.close(websocket.StatusGoingAway, "falha de escrita")
				return
			}
		case <-c.closed:
			return
		case <-ctx.Done():
			return
		}
	}
}

func frame(op int, t string, s int64, d any) []byte {
	b, _ := json.Marshal(outFrame{Op: op, T: t, S: s, D: d})
	return b
}

// ---- sessão lógica (sobrevive a quedas de conexão por ResumeWindow) ----

type bufferedEvent struct {
	seq  int64
	data []byte
}

type Session struct {
	ID     string
	UserID ID

	mu         sync.Mutex
	seq        int64
	buf        []bufferedEvent
	conn       *conn
	detachedAt time.Time

	guilds map[ID]struct{} // protegido por Hub.mu
}

func (s *Session) dispatch(t string, d json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	b := frame(OpDispatch, t, s.seq, d)
	s.buf = append(s.buf, bufferedEvent{s.seq, b})
	if len(s.buf) > replayBuffer {
		s.buf = s.buf[len(s.buf)-replayBuffer:]
	}
	if s.conn != nil {
		s.conn.send(b)
	}
}

// ---- hub ----

type Hub struct {
	store   *store.Store
	log     *slog.Logger
	origins []string

	// Limiter, quando definido, limita conexões novas por IP.
	Limiter    *ratelimit.Limiter
	TrustProxy bool

	mu        sync.Mutex
	sessions  map[string]*Session
	byUser    map[ID]map[*Session]struct{}
	byGuild   map[ID]map[*Session]struct{}
	presences map[ID]Presence
}

func NewHub(st *store.Store, log *slog.Logger, origins []string) *Hub {
	return &Hub{
		store: st, log: log, origins: origins,
		sessions:  map[string]*Session{},
		byUser:    map[ID]map[*Session]struct{}{},
		byGuild:   map[ID]map[*Session]struct{}{},
		presences: map[ID]Presence{},
	}
}

// Run remove periodicamente as sessões que caíram e não foram retomadas.
func (h *Hub) Run(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.reap()
		}
	}
}

func (h *Hub) reap() {
	var offline []Presence
	var offlineGuilds [][]ID
	h.mu.Lock()
	for id, s := range h.sessions {
		s.mu.Lock()
		dead := s.conn == nil && !s.detachedAt.IsZero() && time.Since(s.detachedAt) > ResumeWindow
		s.mu.Unlock()
		if !dead {
			continue
		}
		delete(h.sessions, id)
		for g := range s.guilds {
			delete(h.byGuild[g], s)
		}
		delete(h.byUser[s.UserID], s)
		if len(h.byUser[s.UserID]) == 0 {
			delete(h.byUser, s.UserID)
			delete(h.presences, s.UserID)
			offline = append(offline, Presence{UserID: s.UserID, Status: "offline"})
			offlineGuilds = append(offlineGuilds, keys(s.guilds))
		}
	}
	h.mu.Unlock()
	for i, p := range offline {
		h.DispatchGuilds(offlineGuilds[i], "PRESENCE_UPDATE", p)
	}
}

func keys(m map[ID]struct{}) []ID {
	out := make([]ID, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func raw(d any) json.RawMessage {
	b, _ := json.Marshal(d)
	return b
}

// DispatchGuilds entrega o evento uma única vez a cada sessão inscrita em qualquer um dos servidores.
func (h *Hub) DispatchGuilds(guildIDs []ID, t string, d any) {
	h.mu.Lock()
	targets := map[*Session]struct{}{}
	for _, g := range guildIDs {
		for s := range h.byGuild[g] {
			targets[s] = struct{}{}
		}
	}
	h.mu.Unlock()
	payload := raw(d)
	for s := range targets {
		s.dispatch(t, payload)
	}
}

func (h *Hub) DispatchGuild(guildID ID, t string, d any) { h.DispatchGuilds([]ID{guildID}, t, d) }

func (h *Hub) DispatchUser(userID ID, t string, d any) {
	h.mu.Lock()
	targets := make([]*Session, 0, len(h.byUser[userID]))
	for s := range h.byUser[userID] {
		targets = append(targets, s)
	}
	h.mu.Unlock()
	payload := raw(d)
	for _, s := range targets {
		s.dispatch(t, payload)
	}
}

// Subscribe inscreve todas as sessões do usuário no tópico do servidor (ao entrar ou criar um servidor).
func (h *Hub) Subscribe(userID, guildID ID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.byUser[userID] {
		s.guilds[guildID] = struct{}{}
		if h.byGuild[guildID] == nil {
			h.byGuild[guildID] = map[*Session]struct{}{}
		}
		h.byGuild[guildID][s] = struct{}{}
	}
}

// Presences devolve a presença dos usuários online dentre os informados.
func (h *Hub) Presences(userIDs []ID) []Presence {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.presencesLocked(userIDs)
}

func (h *Hub) presencesLocked(userIDs []ID) []Presence {
	out := []Presence{}
	for _, u := range userIDs {
		if p, ok := h.presences[u]; ok {
			out = append(out, p)
		}
	}
	return out
}

func (h *Hub) Presence(userID ID) Presence {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p, ok := h.presences[userID]; ok {
		return p
	}
	return Presence{UserID: userID, Status: "offline"}
}

// ---- ciclo de vida de uma conexão ----

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Limiter != nil {
		if ok, wait := h.Limiter.Allow(r.Context(), ratelimit.Identify, ratelimit.ClientIP(r, h.TrustProxy)); !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
			http.Error(w, "conexões demais, tente de novo em instantes", http.StatusTooManyRequests)
			return
		}
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	c := &conn{ws: ws, out: make(chan []byte, outQueue), closed: make(chan struct{})}
	go c.writeLoop(ctx)
	c.send(frame(OpHello, "", 0, map[string]any{"heartbeat_interval": HeartbeatInterval.Milliseconds()}))

	sess := h.handshake(ctx, c)
	if sess == nil {
		return
	}
	defer h.detach(sess, c)

	for {
		// Sem heartbeat dentro de 1,5 intervalo a conexão é considerada morta.
		rctx, rcancel := context.WithTimeout(ctx, HeartbeatInterval*3/2)
		_, data, err := ws.Read(rctx)
		rcancel()
		if err != nil {
			c.close(CloseSessionTimeout, "sem heartbeat")
			return
		}
		var f inFrame
		if json.Unmarshal(data, &f) != nil {
			c.close(CloseDecodeError, "json inválido")
			return
		}
		switch f.Op {
		case OpHeartbeat:
			c.send(frame(OpHeartbeatAck, "", 0, nil))
		case OpPresence:
			h.handlePresence(sess, f.D)
		default:
			c.close(CloseUnknownOpcode, "opcode desconhecido")
			return
		}
	}
}

func (h *Hub) readFirst(ctx context.Context, c *conn) (inFrame, error) {
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, data, err := c.ws.Read(rctx)
	if err != nil {
		return inFrame{}, err
	}
	var f inFrame
	err = json.Unmarshal(data, &f)
	return f, err
}

// handshake espera IDENTIFY ou RESUME. Um RESUME recusado recebe INVALID_SESSION e pode tentar IDENTIFY no mesmo socket.
func (h *Hub) handshake(ctx context.Context, c *conn) *Session {
	for attempt := 0; attempt < 3; attempt++ {
		f, err := h.readFirst(ctx, c)
		if err != nil {
			c.close(CloseDecodeError, "handshake inválido")
			return nil
		}
		switch f.Op {
		case OpIdentify:
			var d struct {
				Token string `json:"token"`
			}
			_ = json.Unmarshal(f.D, &d)
			user, err := h.store.UserBySession(ctx, auth.HashToken(d.Token))
			if err != nil {
				c.close(CloseAuthFailed, "autenticação falhou")
				return nil
			}
			s, err := h.identify(ctx, c, user)
			if err != nil {
				h.log.Error("identify", "err", err)
				c.close(websocket.StatusInternalError, "erro interno")
				return nil
			}
			return s
		case OpResume:
			var d struct {
				Token     string `json:"token"`
				SessionID string `json:"session_id"`
				Seq       int64  `json:"seq"`
			}
			_ = json.Unmarshal(f.D, &d)
			user, err := h.store.UserBySession(ctx, auth.HashToken(d.Token))
			if err != nil {
				c.close(CloseAuthFailed, "autenticação falhou")
				return nil
			}
			if s := h.resume(c, user.ID, d.SessionID, d.Seq); s != nil {
				return s
			}
			c.send(frame(OpInvalidSession, "", 0, false))
		case OpHeartbeat:
			c.send(frame(OpHeartbeatAck, "", 0, nil))
			attempt--
		default:
			c.close(CloseNotAuth, "não autenticado")
			return nil
		}
	}
	c.close(CloseNotAuth, "não autenticado")
	return nil
}

func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *Hub) identify(ctx context.Context, c *conn, user store.User) (*Session, error) {
	guilds, err := h.store.GuildsForUser(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	readStates, err := h.store.ReadStates(ctx, user.ID, user.Username)
	if err != nil {
		return nil, err
	}
	s := &Session{ID: newSessionID(), UserID: user.ID, guilds: map[ID]struct{}{}, conn: c}

	h.mu.Lock()
	h.sessions[s.ID] = s
	if h.byUser[user.ID] == nil {
		h.byUser[user.ID] = map[*Session]struct{}{}
	}
	h.byUser[user.ID][s] = struct{}{}
	memberIDs := []ID{}
	for _, g := range guilds {
		s.guilds[g.ID] = struct{}{}
		if h.byGuild[g.ID] == nil {
			h.byGuild[g.ID] = map[*Session]struct{}{}
		}
		h.byGuild[g.ID][s] = struct{}{}
		for _, m := range g.Members {
			memberIDs = append(memberIDs, m.User.ID)
		}
	}
	_, wasOnline := h.presences[user.ID]
	if !wasOnline {
		h.presences[user.ID] = Presence{UserID: user.ID, Status: "online"}
	}
	// READY sai como seq 1, antes que qualquer outro evento alcance esta sessão.
	s.dispatch("READY", raw(map[string]any{
		"session_id":  s.ID,
		"user":        user,
		"guilds":      guilds,
		"presences":   h.presencesLocked(memberIDs),
		"read_states": readStates,
	}))
	me := h.presences[user.ID]
	h.mu.Unlock()

	if !wasOnline {
		h.DispatchGuilds(keys(s.guilds), "PRESENCE_UPDATE", me)
	}
	return s, nil
}

func (h *Hub) resume(c *conn, userID ID, sessionID string, seq int64) *Session {
	h.mu.Lock()
	s := h.sessions[sessionID]
	h.mu.Unlock()
	if s == nil || s.UserID != userID {
		return nil
	}
	s.mu.Lock()
	if seq > s.seq || (len(s.buf) > 0 && seq < s.buf[0].seq-1) {
		s.mu.Unlock()
		return nil // há eventos perdidos que já saíram do buffer
	}
	if s.conn != nil {
		s.conn.close(websocket.StatusGoingAway, "sessão retomada em outra conexão")
	}
	s.conn = c
	s.detachedAt = time.Time{}
	replayed := 0
	for _, e := range s.buf {
		if e.seq > seq {
			c.send(e.data)
			replayed++
		}
	}
	s.mu.Unlock()
	s.dispatch("RESUMED", raw(map[string]any{"replayed": replayed}))
	return s
}

func (h *Hub) detach(s *Session, c *conn) {
	s.mu.Lock()
	if s.conn == c {
		s.conn = nil
		s.detachedAt = time.Now()
	}
	s.mu.Unlock()
	c.close(websocket.StatusNormalClosure, "")
}

func (h *Hub) handlePresence(s *Session, d json.RawMessage) {
	var in struct {
		Status   string `json:"status"`
		Activity string `json:"activity"`
	}
	if json.Unmarshal(d, &in) != nil {
		return
	}
	switch in.Status {
	case "online", "idle", "dnd":
	default:
		return
	}
	if len(in.Activity) > 128 {
		in.Activity = in.Activity[:128]
	}
	p := Presence{UserID: s.UserID, Status: in.Status, Activity: in.Activity}
	h.mu.Lock()
	h.presences[s.UserID] = p
	guilds := map[ID]struct{}{}
	for other := range h.byUser[s.UserID] {
		for g := range other.guilds {
			guilds[g] = struct{}{}
		}
	}
	h.mu.Unlock()
	h.DispatchGuilds(keys(guilds), "PRESENCE_UPDATE", p)
}
