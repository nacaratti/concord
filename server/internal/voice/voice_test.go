package voice

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

var cfg = Config{APIKey: "k", APISecret: "segredo-de-teste-com-32-caracteres!!"}

func TestTokenClaims(t *testing.T) {
	tok, err := cfg.Token("1:abc", "Ana", Room("42"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	raw, _ := b64.DecodeString(parts[1])
	var c struct {
		Iss, Sub string
		Video    videoGrant
	}
	_ = json.Unmarshal(raw, &c)
	if c.Iss != "k" || c.Sub != "1:abc" || c.Video.Room != "voice:42" || !c.Video.RoomJoin {
		t.Fatalf("claims inesperados: %+v", c)
	}
}

func webhookAuth(secret string, body []byte) string {
	sum := sha256.Sum256(body)
	tok, _ := sign(secret, map[string]any{"iss": "k", "exp": time.Now().Add(time.Minute).Unix(),
		"sha256": base64.StdEncoding.EncodeToString(sum[:])})
	return tok
}

func TestVerifyWebhook(t *testing.T) {
	body := []byte(`{"event":"participant_left","room":{"name":"voice:42"},"participant":{"identity":"1:abc"}}`)
	ev, err := cfg.VerifyWebhook(webhookAuth(cfg.APISecret, body), body)
	if err != nil || ev.Event != "participant_left" || ev.Participant.Identity != "1:abc" {
		t.Fatalf("webhook válido recusado: %v %+v", err, ev)
	}
	if _, err := cfg.VerifyWebhook(webhookAuth("outro-segredo", body), body); err == nil {
		t.Fatal("aceitou assinatura com segredo errado")
	}
	tampered := []byte(strings.Replace(string(body), "1:abc", "2:xyz", 1))
	if _, err := cfg.VerifyWebhook(webhookAuth(cfg.APISecret, body), tampered); err == nil {
		t.Fatal("aceitou corpo adulterado")
	}
}
