package gateway

import (
	"context"
	"encoding/json"
	"time"

	"concord/internal/store"
	"concord/internal/voice"
)

// VoiceState diz em qual canal de voz o usuário está, e por qual sessão do gateway.
// ChannelID nulo significa que ele saiu. Vive só em memória, como no plano: perde sentido se o servidor reinicia.
type VoiceState struct {
	GuildID   ID     `json:"guild_id"`
	ChannelID *ID    `json:"channel_id"`
	UserID    ID     `json:"user_id"`
	SessionID string `json:"session_id"`
	SelfMute  bool   `json:"self_mute"`
	SelfDeaf  bool   `json:"self_deaf"`
	// SelfStream: está compartilhando a tela. Vai pelo gateway para quem está fora da call ver o "AO VIVO".
	SelfStream bool `json:"self_stream"`
}

const voiceTokenTTL = 6 * time.Hour

// VoiceStates devolve quem está em call nos servidores informados (para o READY e o GUILD_CREATE).
func (h *Hub) VoiceStates(guildIDs ...ID) []VoiceState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.voiceStatesLocked(guildIDs)
}

func (h *Hub) voiceStatesLocked(guildIDs []ID) []VoiceState {
	want := map[ID]bool{}
	for _, g := range guildIDs {
		want[g] = true
	}
	out := []VoiceState{}
	for _, vs := range h.voiceStates {
		if want[vs.GuildID] {
			out = append(out, vs)
		}
	}
	return out
}

func left(vs VoiceState) VoiceState {
	vs.ChannelID = nil
	vs.SelfMute, vs.SelfDeaf, vs.SelfStream = false, false, false
	return vs
}

// handleVoiceState trata o op 4: entrar, trocar de canal, sair, ou só mudar mute/deafen.
func (h *Hub) handleVoiceState(ctx context.Context, s *Session, d json.RawMessage) {
	var in struct {
		GuildID    ID   `json:"guild_id"`
		ChannelID  *ID  `json:"channel_id"`
		SelfMute   bool `json:"self_mute"`
		SelfDeaf   bool `json:"self_deaf"`
		SelfStream bool `json:"self_stream"`
	}
	if json.Unmarshal(d, &in) != nil {
		return
	}
	if in.ChannelID != nil {
		ch, err := h.store.Channel(ctx, *in.ChannelID)
		if err != nil || ch.GuildID != in.GuildID || ch.Kind != store.ChannelVoice {
			return
		}
	}

	type dispatch struct {
		guild ID
		state VoiceState
	}
	var out []dispatch
	needToken := false

	h.mu.Lock()
	if _, member := s.guilds[in.GuildID]; !member {
		h.mu.Unlock()
		return // só entra em call de servidor do qual participa
	}
	prev, hadPrev := h.voiceStates[s.UserID]
	if in.ChannelID == nil {
		if hadPrev {
			delete(h.voiceStates, s.UserID)
			out = append(out, dispatch{prev.GuildID, left(prev)})
		}
	} else {
		if in.SelfDeaf {
			in.SelfMute = true // quem não ouve também não fala
		}
		st := VoiceState{GuildID: in.GuildID, ChannelID: in.ChannelID, UserID: s.UserID, SessionID: s.ID,
			SelfMute: in.SelfMute, SelfDeaf: in.SelfDeaf, SelfStream: in.SelfStream}
		h.voiceStates[s.UserID] = st
		if hadPrev && prev.GuildID != st.GuildID {
			out = append(out, dispatch{prev.GuildID, left(prev)})
		}
		out = append(out, dispatch{st.GuildID, st})
		// Mudar só mute/deafen não precisa de token novo; trocar de canal ou de aba precisa.
		needToken = !hadPrev || *prev.ChannelID != *st.ChannelID || prev.SessionID != s.ID
	}
	h.mu.Unlock()

	for _, o := range out {
		h.DispatchGuild(o.guild, "VOICE_STATE_UPDATE", o.state)
	}
	if needToken && h.Voice != nil {
		id := voice.Identity(s.UserID.String(), s.ID)
		token, err := h.Voice.Token(id, s.Name, voice.Room(in.ChannelID.String()), voiceTokenTTL)
		if err != nil {
			h.log.Error("token do livekit", "err", err)
			return
		}
		// Só esta sessão recebe o token: é a credencial para entrar na sala.
		s.dispatchNow("VOICE_SERVER_UPDATE", map[string]any{
			"guild_id": in.GuildID, "channel_id": in.ChannelID, "token": token, "endpoint": h.Voice.PublicURL,
		})
	}
}

// ClearVoice tira o usuário da call se ele ainda estiver nela pela mesma sessão e canal.
// Chamado pelo webhook do LiveKit quando um participante cai (aba fechada, rede perdida).
func (h *Hub) ClearVoice(userID ID, sessionID string, channelID ID) {
	h.mu.Lock()
	vs, ok := h.voiceStates[userID]
	if !ok || vs.SessionID != sessionID || vs.ChannelID == nil || *vs.ChannelID != channelID {
		h.mu.Unlock()
		return
	}
	delete(h.voiceStates, userID)
	h.mu.Unlock()
	h.DispatchGuild(vs.GuildID, "VOICE_STATE_UPDATE", left(vs))
}

// clearVoiceForSessionLocked remove o estado de voz ligado a uma sessão que morreu. Exige h.mu.
func (h *Hub) clearVoiceForSessionLocked(s *Session) (VoiceState, bool) {
	vs, ok := h.voiceStates[s.UserID]
	if !ok || vs.SessionID != s.ID {
		return VoiceState{}, false
	}
	delete(h.voiceStates, s.UserID)
	return left(vs), true
}
