package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/vmihailenco/msgpack/v5"
)

// Encoding é a codificação dos frames que o servidor envia, escolhida pelo cliente ao conectar
// (/gateway?encoding=msgpack). O cliente sempre envia JSON: são frames pequenos e raros.
type Encoding int

const (
	EncodingJSON Encoding = iota
	EncodingMsgpack
)

func ParseEncoding(s string) (Encoding, bool) {
	switch s {
	case "", "json":
		return EncodingJSON, true
	case "msgpack":
		return EncodingMsgpack, true
	}
	return 0, false
}

func (e Encoding) String() string {
	if e == EncodingMsgpack {
		return "msgpack"
	}
	return "json"
}

// payload é o "d" de um evento, serializado uma vez por publicação. A versão MessagePack só é
// calculada se alguma sessão inscrita pediu essa codificação, e uma vez só para todas elas.
type payload struct {
	json json.RawMessage
	once sync.Once
	mp   []byte
	err  error
}

func newPayload(raw json.RawMessage) *payload { return &payload{json: raw} }

func (p *payload) msgpack() ([]byte, error) {
	p.once.Do(func() { p.mp, p.err = MsgpackFromJSON(p.json) })
	return p.mp, p.err
}

// MsgpackFromJSON reescreve um JSON em MessagePack. Números inteiros viram inteiros, os IDs continuam
// strings (como no JSON: um int64 perderia precisão no JavaScript) e a forma dos objetos não muda,
// então o cliente trata os dois formatos com o mesmo código.
func MsgpackFromJSON(raw []byte) ([]byte, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return msgpack.Marshal(nil)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return msgpack.Marshal(normalize(v))
}

func normalize(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		f, _ := x.Float64()
		return f
	case map[string]any:
		for k, e := range x {
			x[k] = normalize(e)
		}
		return x
	case []any:
		for i, e := range x {
			x[i] = normalize(e)
		}
		return x
	}
	return v
}

type mpFrame struct {
	Op int                `msgpack:"op"`
	T  string             `msgpack:"t,omitempty"`
	S  int64              `msgpack:"s,omitempty"`
	D  msgpack.RawMessage `msgpack:"d"`
}

// encodeFrame monta o envelope {op, t, s, d} na codificação pedida.
func encodeFrame(enc Encoding, op int, t string, s int64, p *payload) ([]byte, error) {
	if enc == EncodingJSON {
		return frame(op, t, s, p.json), nil
	}
	d, err := p.msgpack()
	if err != nil {
		return nil, fmt.Errorf("msgpack: %w", err)
	}
	return msgpack.Marshal(mpFrame{Op: op, T: t, S: s, D: d})
}

// control monta frames que não são DISPATCH (HELLO, HEARTBEAT_ACK, INVALID_SESSION).
func control(enc Encoding, op int, d any) []byte {
	raw, _ := json.Marshal(d)
	b, err := encodeFrame(enc, op, "", 0, newPayload(raw))
	if err != nil {
		return frame(op, "", 0, d)
	}
	return b
}
