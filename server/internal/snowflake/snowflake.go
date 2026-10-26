// Package snowflake gera IDs de 64 bits ordenáveis no tempo, no mesmo formato do Discord:
// 42 bits de timestamp (ms desde Epoch) | 10 bits de worker | 12 bits de sequência.
package snowflake

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// Epoch do Concord: 2026-01-01T00:00:00Z.
const Epoch int64 = 1767225600000

// ID é serializado em JSON como string, porque números de 64 bits perdem precisão em JavaScript.
type ID int64

func (id ID) String() string { return strconv.FormatInt(int64(id), 10) }

// Time devolve o instante de criação embutido no ID.
func (id ID) Time() time.Time {
	return time.UnixMilli((int64(id) >> 22) + Epoch)
}

func (id ID) MarshalJSON() ([]byte, error) {
	return []byte(`"` + id.String() + `"`), nil
}

func (id *ID) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		var n int64
		if err2 := json.Unmarshal(b, &n); err2 != nil {
			return err
		}
		*id = ID(n)
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return err
	}
	*id = ID(n)
	return nil
}

func Parse(s string) (ID, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	return ID(n), err
}

type Generator struct {
	mu     sync.Mutex
	worker int64
	lastMs int64
	seq    int64
}

func NewGenerator(worker int64) *Generator {
	return &Generator{worker: worker & 0x3FF}
}

func (g *Generator) Next() ID {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now().UnixMilli() - Epoch
	if now < g.lastMs {
		now = g.lastMs // relógio voltou: segura no último ms visto
	}
	if now == g.lastMs {
		g.seq = (g.seq + 1) & 0xFFF
		if g.seq == 0 {
			for now <= g.lastMs { // sequência esgotada neste ms
				time.Sleep(100 * time.Microsecond)
				now = time.Now().UnixMilli() - Epoch
			}
		}
	} else {
		g.seq = 0
	}
	g.lastMs = now
	return ID(now<<22 | g.worker<<12 | g.seq)
}
