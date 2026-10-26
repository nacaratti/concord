// Package ratelimit implementa um token bucket atômico no Redis: cada chave tem até `burst`
// fichas e ganha `rate` fichas por segundo. Toda ação gasta uma ficha.
package ratelimit

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Rule descreve um balde: até Burst ações seguidas, repostas a Rate por segundo.
type Rule struct {
	Name  string
	Rate  float64
	Burst int
}

var (
	Login    = Rule{"login", 5.0 / 60, 5}      // 5 tentativas, depois 1 a cada 12 s
	Register = Rule{"register", 3.0 / 3600, 3} // 3 contas por IP por hora
	Message  = Rule{"msg", 1, 5}               // 5 mensagens de rajada, depois 1/s
	Write    = Rule{"write", 0.5, 10}          // criar servidor, canal, convite, editar...
	Identify = Rule{"identify", 0.5, 30}       // conexões novas ao gateway por IP (folgado: amigos na mesma rede dividem o IP)
)

// O script roda inteiro dentro do Redis, então duas requisições simultâneas nunca gastam a mesma ficha.
var bucket = redis.NewScript(`
local rate  = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now   = tonumber(ARGV[3])
local d = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) / 1000 * rate)
local allowed, wait = 0, 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return {allowed, wait}
`)

type Limiter struct {
	rdb *redis.Client
	log *slog.Logger
}

func New(rdb *redis.Client, log *slog.Logger) *Limiter { return &Limiter{rdb: rdb, log: log} }

// Allow gasta uma ficha do balde `rule` para `key`. Se o Redis falhar, deixa passar (fail open):
// para um grupo de amigos, ficar fora do ar é pior que ficar sem limite por um instante.
func (l *Limiter) Allow(ctx context.Context, rule Rule, key string) (bool, time.Duration) {
	res, err := bucket.Run(ctx, l.rdb, []string{"rl:" + rule.Name + ":" + key},
		rule.Rate, rule.Burst, time.Now().UnixMilli()).Int64Slice()
	if err != nil {
		l.log.Warn("rate limit indisponível", "err", err)
		return true, 0
	}
	return res[0] == 1, time.Duration(res[1]) * time.Millisecond
}

// ClientIP devolve o IP de quem fez a requisição, sem a porta. Com trustProxy, confia no
// X-Forwarded-For (ligue só atrás de um proxy reverso como o Caddy).
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			ip, _, _ := strings.Cut(xff, ",")
			return strings.TrimSpace(ip)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
