package snowflake

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNextIsMonotonicAndUnique(t *testing.T) {
	g := NewGenerator(1)
	prev := g.Next()
	for i := 0; i < 100000; i++ {
		id := g.Next()
		if id <= prev {
			t.Fatalf("id %d não é maior que %d", id, prev)
		}
		prev = id
	}
}

func TestTimeRoundTrip(t *testing.T) {
	id := NewGenerator(0).Next()
	if d := time.Since(id.Time()); d < 0 || d > time.Second {
		t.Fatalf("timestamp embutido fora do esperado: %v", d)
	}
}

func TestJSONIsString(t *testing.T) {
	id := ID(1298374650123456512)
	b, _ := json.Marshal(id)
	if string(b) != `"1298374650123456512"` {
		t.Fatalf("got %s", b)
	}
	var back ID
	if err := json.Unmarshal(b, &back); err != nil || back != id {
		t.Fatalf("round trip falhou: %v %d", err, back)
	}
}
