// Package voice fala com o LiveKit: emite os tokens de acesso às salas e valida os webhooks.
// Os dois são JWT HS256 assinados com o segredo da API do LiveKit, escritos à mão para ficar claro o que levam.
package voice

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Config struct {
	APIKey    string
	APISecret string
	// URL que o navegador usa para falar com o LiveKit (ws:// em dev, wss:// em produção).
	PublicURL string
}

// Room é o nome da sala do LiveKit para um canal de voz.
func Room(channelID string) string { return "voice:" + channelID }

// Identity identifica um participante. Leva a sessão do gateway para que duas abas do mesmo
// usuário não se derrubem e para que o webhook de saída de uma sessão antiga não apague a nova.
func Identity(userID, sessionID string) string { return userID + ":" + sessionID }

func ParseIdentity(identity string) (userID, sessionID string, ok bool) {
	return strings.Cut(identity, ":")
}

var b64 = base64.RawURLEncoding

func sign(secret string, claims any) (string, error) {
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := header + "." + b64.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + b64.EncodeToString(mac.Sum(nil)), nil
}

type videoGrant struct {
	Room              string   `json:"room"`
	RoomJoin          bool     `json:"roomJoin"`
	CanPublish        bool     `json:"canPublish"`
	CanSubscribe      bool     `json:"canSubscribe"`
	CanPublishData    bool     `json:"canPublishData"`
	CanPublishSources []string `json:"canPublishSources"`
}

// Token autoriza `identity` a entrar na sala e publicar só microfone e tela (Fase 4) — nunca câmera nem dados.
func (c Config) Token(identity, name, room string, ttl time.Duration) (string, error) {
	now := time.Now()
	return sign(c.APISecret, map[string]any{
		"iss":  c.APIKey,
		"sub":  identity,
		"name": name,
		"nbf":  now.Add(-10 * time.Second).Unix(),
		"exp":  now.Add(ttl).Unix(),
		"video": videoGrant{
			Room: room, RoomJoin: true, CanPublish: true, CanSubscribe: true,
			CanPublishSources: []string{"microphone", "screen_share", "screen_share_audio"},
		},
	})
}

// Event é o pedaço do webhook do LiveKit que o Concord usa.
type Event struct {
	Event string `json:"event"`
	Room  struct {
		Name string `json:"name"`
	} `json:"room"`
	Participant struct {
		Identity string `json:"identity"`
	} `json:"participant"`
}

var ErrBadWebhook = errors.New("webhook inválido")

// VerifyWebhook confere a assinatura: o header Authorization é um JWT do LiveKit cujo claim
// sha256 é o hash do corpo. Assim ninguém de fora consegue tirar alguém da call por webhook falso.
func (c Config) VerifyWebhook(authHeader string, body []byte) (Event, error) {
	var ev Event
	token := strings.TrimPrefix(authHeader, "Bearer ")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ev, ErrBadWebhook
	}
	mac := hmac.New(sha256.New, []byte(c.APISecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return ev, ErrBadWebhook
	}
	raw, err := b64.DecodeString(parts[1])
	if err != nil {
		return ev, ErrBadWebhook
	}
	var claims struct {
		Iss    string `json:"iss"`
		Exp    int64  `json:"exp"`
		Sha256 string `json:"sha256"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Iss != c.APIKey || (claims.Exp != 0 && time.Now().Unix() > claims.Exp) {
		return ev, ErrBadWebhook
	}
	sum := sha256.Sum256(body)
	if subtle.ConstantTimeCompare([]byte(base64.StdEncoding.EncodeToString(sum[:])), []byte(claims.Sha256)) != 1 {
		return ev, ErrBadWebhook
	}
	err = json.Unmarshal(body, &ev)
	return ev, err
}
