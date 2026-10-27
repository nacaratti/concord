package gateway

import (
	"bytes"
	"compress/flate"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/vmihailenco/msgpack/v5"

	"concord/internal/snowflake"
	"concord/internal/store"
)

func TestMsgpackRoundTrip(t *testing.T) {
	msg := store.Message{
		ID: 1298374650123456512, ChannelID: 1298374650123456513, GuildID: 1298374650123456514,
		Author:  store.User{ID: 1298374650123456515, Username: "ana", DisplayName: "Ana"},
		Content: "bora jogar? 🎮", Attachments: json.RawMessage(`[]`), Timestamp: time.Unix(1790000000, 0).UTC(),
	}
	raw, _ := json.Marshal(msg)
	b, err := encodeFrame(EncodingMsgpack, OpDispatch, "MESSAGE_CREATE", 42, newPayload(raw))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := msgpack.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	d := got["d"].(map[string]any)
	if got["t"] != "MESSAGE_CREATE" || got["s"] != int8(42) && got["s"] != int64(42) && got["s"] != uint8(42) {
		t.Fatalf("envelope inesperado: %#v", got)
	}
	// IDs continuam strings (sem perda de precisão no JS) e o texto chega intacto.
	if d["id"] != "1298374650123456512" || d["content"] != "bora jogar? 🎮" {
		t.Fatalf("payload inesperado: %#v", d)
	}
	if d["author"].(map[string]any)["username"] != "ana" {
		t.Fatalf("autor inesperado: %#v", d["author"])
	}
}

// ---- relatório de banda (CONCORD_BANDWIDTH=1 go test -run Bandwidth -v ./internal/gateway) ----

var phrases = []string{
	"bora jogar?", "alguém online pra um ranked?", "entra na call", "kkkkkk", "gg", "que jogada!",
	"vou pegar um café e já volto", "ontem a gente perdeu feio no último round",
	"alguém viu o patch novo? mudaram o mapa inteiro", "@ana tá vindo?", "to dentro", "5 min",
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "quem vai de suporte hoje?", "lag absurdo aqui",
}

type traffic struct {
	ready  []byte   // payload do READY
	events []string // tipos
	data   [][]byte // payloads JSON
}

func makeTraffic(n int) traffic {
	r := rand.New(rand.NewPCG(1, 2))
	gen := snowflake.NewGenerator(3)
	var users []store.User
	for i := range 50 {
		users = append(users, store.User{ID: gen.Next(), Username: fmt.Sprintf("jogador_%02d", i), DisplayName: fmt.Sprintf("Jogador %d", i)})
	}
	var guilds []store.Guild
	var reads []store.ReadState
	for gi := range 3 {
		g := store.Guild{ID: gen.Next(), Name: fmt.Sprintf("Servidor %d", gi), OwnerID: users[0].ID}
		for ci := range 8 {
			last := gen.Next()
			c := store.Channel{ID: gen.Next(), GuildID: g.ID, Name: fmt.Sprintf("canal-%d", ci), Kind: ci / 6, Position: ci, LastMessageID: &last}
			g.Channels = append(g.Channels, c)
			reads = append(reads, store.ReadState{ChannelID: c.ID, LastReadID: last})
		}
		for _, u := range users {
			g.Members = append(g.Members, store.Member{User: u, JoinedAt: time.Unix(1780000000, 0).UTC()})
		}
		guilds = append(guilds, g)
	}
	var presences []Presence
	for _, u := range users[:40] {
		presences = append(presences, Presence{UserID: u.ID, Status: "online", Activity: "Valorant"})
	}
	ready, _ := json.Marshal(map[string]any{"session_id": "8cf152c474fb76fa416dc4b9cc7ff1f9", "user": users[0],
		"guilds": guilds, "presences": presences, "read_states": reads, "voice_states": []VoiceState{}})

	tr := traffic{ready: ready}
	for range n {
		g := guilds[r.IntN(len(guilds))]
		c := g.Channels[r.IntN(6)]
		u := users[r.IntN(len(users))]
		var t string
		var d any
		switch x := r.IntN(10); {
		case x < 7:
			t = "MESSAGE_CREATE"
			id := gen.Next()
			d = store.Message{ID: id, ChannelID: c.ID, GuildID: g.ID, Author: u, Content: phrases[r.IntN(len(phrases))],
				Attachments: json.RawMessage(`[]`), Timestamp: id.Time(), Nonce: fmt.Sprintf("%x", r.Uint64())}
		case x < 9:
			t = "TYPING_START"
			d = map[string]any{"channel_id": c.ID, "guild_id": g.ID, "user_id": u.ID, "timestamp": 1790000000 + r.IntN(1000)}
		default:
			t = "PRESENCE_UPDATE"
			d = Presence{UserID: u.ID, Status: []string{"online", "idle", "dnd"}[r.IntN(3)], Activity: "Valorant"}
		}
		b, _ := json.Marshal(d)
		tr.events = append(tr.events, t)
		tr.data = append(tr.data, b)
	}
	return tr
}

// Simula a compressão do transporte sobre a sequência de mensagens de UMA conexão.
type compressor interface {
	add(msg []byte) int // bytes no fio
	name() string
}

type none struct{}

func (none) add(m []byte) int { return len(m) }
func (none) name() string     { return "sem compressão" }

// permessage-deflate como o coder/websocket faz: BestSpeed, sync flush por mensagem, sem os 4 bytes do fim.
type deflate struct {
	takeover  bool
	threshold int
	buf       bytes.Buffer
	w         *flate.Writer
}

func newDeflate(takeover bool) *deflate {
	d := &deflate{takeover: takeover, threshold: 512}
	if takeover {
		d.threshold = 128
		d.w, _ = flate.NewWriter(&d.buf, flate.BestSpeed)
	}
	return d
}

func (d *deflate) add(m []byte) int {
	if len(m) < d.threshold {
		return len(m)
	}
	d.buf.Reset()
	w := d.w
	if !d.takeover {
		w, _ = flate.NewWriter(&d.buf, flate.BestSpeed)
	}
	_, _ = w.Write(m)
	_ = w.Flush()
	return d.buf.Len() - 4
}

func (d *deflate) name() string {
	if d.takeover {
		return "permessage-deflate (com contexto)"
	}
	return "permessage-deflate (sem contexto)"
}

// zstd-stream como o Discord: um único fluxo por conexão, flush a cada mensagem.
type zstdStream struct {
	buf bytes.Buffer
	w   *zstd.Encoder
}

func newZstd() *zstdStream {
	z := &zstdStream{}
	z.w, _ = zstd.NewWriter(&z.buf, zstd.WithEncoderLevel(zstd.SpeedFastest), zstd.WithWindowSize(1<<16),
		zstd.WithEncoderConcurrency(1), zstd.WithLowerEncoderMem(true))
	return z
}

func (z *zstdStream) add(m []byte) int {
	z.buf.Reset()
	_, _ = z.w.Write(m)
	_ = z.w.Flush()
	return z.buf.Len()
}
func (z *zstdStream) name() string { return "zstd-stream" }

// memória fixa por conexão de cada compressor, medida criando 200 deles.
func memPer(newC func() compressor) int64 {
	const n = 200
	runtime.GC()
	var a, b runtime.MemStats
	runtime.ReadMemStats(&a)
	keep := make([]compressor, n)
	for i := range keep {
		keep[i] = newC()
		keep[i].add(bytes.Repeat([]byte(`{"op":0,"t":"MESSAGE_CREATE"}`), 20)) // aloca as estruturas internas
	}
	runtime.GC()
	runtime.ReadMemStats(&b)
	runtime.KeepAlive(keep)
	return int64(b.HeapAlloc-a.HeapAlloc) / n
}

func TestBandwidthReport(t *testing.T) {
	if os.Getenv("CONCORD_BANDWIDTH") == "" {
		t.Skip("relatório: rode com CONCORD_BANDWIDTH=1")
	}
	const n = 2000
	tr := makeTraffic(n)
	encs := []Encoding{EncodingJSON, EncodingMsgpack}
	comps := []func() compressor{
		func() compressor { return none{} },
		func() compressor { return newDeflate(false) },
		func() compressor { return newDeflate(true) },
		func() compressor { return newZstd() },
	}
	var out strings.Builder
	fmt.Fprintf(&out, "\nTráfego: READY (%d B em JSON) + %d eventos (70%% mensagens, 20%% digitando, 10%% presença)\n\n", len(tr.ready), n)
	fmt.Fprintf(&out, "| codificação | transporte | READY | eventos | média/evento | CPU/evento | memória fixa/conexão |\n|---|---|---:|---:|---:|---:|---:|\n")
	for _, enc := range encs {
		for _, newC := range comps {
			c := newC()
			readyFrame, _ := encodeFrame(enc, OpDispatch, "READY", 1, newPayload(tr.ready))
			readyBytes := c.add(readyFrame)
			start := time.Now()
			total := 0
			for i := range tr.data {
				// Como em produção: o payload é codificado uma vez e o envelope por sessão.
				f, err := encodeFrame(enc, OpDispatch, tr.events[i], int64(i+2), newPayload(tr.data[i]))
				if err != nil {
					t.Fatal(err)
				}
				total += c.add(f)
			}
			cpu := time.Since(start) / n
			mem := memPer(newC)
			fmt.Fprintf(&out, "| %s | %s | %.1f KB | %.1f KB | %d B | %s | %s |\n", enc, c.name(),
				float64(readyBytes)/1024, float64(total)/1024, total/n, cpu.Round(100*time.Nanosecond), fmtMem(mem))
		}
	}
	t.Log(out.String())
}

func fmtMem(b int64) string {
	if b < 1024 {
		return "~0"
	}
	if b < 1<<20 {
		return fmt.Sprintf("%d KB", b/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(b)/(1<<20))
}
