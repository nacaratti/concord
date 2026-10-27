// Package metrics define o que o Concord expõe para o Prometheus. Memória, goroutines e GC do Go
// já vêm de graça no registro padrão; aqui ficam as métricas da aplicação.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Faixas de latência pensadas na meta do plano: entregar mensagem em menos de 100 ms.
var latencyBuckets = []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5}

var (
	GatewayConnections = promauto.NewCounter(prometheus.CounterOpts{
		Name: "concord_gateway_connections_total",
		Help: "WebSockets aceitos no gateway.",
	})
	GatewayIdentifies = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "concord_gateway_handshakes_total",
		Help: "Handshakes concluídos, por tipo (identify, resume) e resultado.",
	}, []string{"kind", "result"})
	GatewayEvents = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "concord_gateway_events_total",
		Help: "Eventos DISPATCH entregues a sessões, por tipo de evento.",
	}, []string{"event"})
	GatewayBytes = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "concord_gateway_bytes_total",
		Help: "Bytes de payload escritos nos WebSockets (antes da compressão do transporte), por codificação.",
	}, []string{"encoding"})
	GatewaySlowConsumers = promauto.NewCounter(prometheus.CounterOpts{
		Name: "concord_gateway_slow_consumers_total",
		Help: "Conexões derrubadas porque a fila de saída encheu.",
	})
	// FanoutLatency mede de quando o evento é publicado até ele ser escrito no socket de cada destinatário.
	// Somado ao tempo do POST (concord_http_request_duration_seconds), dá a latência de entrega no servidor.
	FanoutLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "concord_gateway_fanout_seconds",
		Help:    "Tempo entre publicar um evento e escrevê-lo no socket de cada destinatário.",
		Buckets: latencyBuckets,
	}, []string{"event"})

	HTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "concord_http_requests_total",
		Help: "Requisições HTTP, por rota e status.",
	}, []string{"route", "code"})
	HTTPDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "concord_http_request_duration_seconds",
		Help:    "Duração das requisições HTTP, por rota.",
		Buckets: latencyBuckets,
	}, []string{"route"})

	RateLimited = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "concord_ratelimit_rejected_total",
		Help: "Requisições recusadas pelo rate limit, por balde.",
	}, []string{"rule"})
)

// Gauges calculados na hora da coleta (sessões, banco). Registrados pelo main, que tem as dependências.
func GaugeFunc(name, help string, f func() float64) {
	promauto.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help}, f)
}

// FanoutEvents lista os eventos cujo tempo de entrega vale medir; os demais só contam.
var FanoutEvents = map[string]bool{"MESSAGE_CREATE": true, "TYPING_START": true, "VOICE_STATE_UPDATE": true}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

// Unwrap deixa o WebSocket e o http.ResponseController chegarem ao writer original.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Middleware conta e cronometra as requisições pela rota do ServeMux ("POST /api/channels/{channel}/messages"),
// nunca pela URL crua: cada id viraria uma série nova no Prometheus.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		next.ServeHTTP(sw, r)
		route := r.Pattern
		if route == "" {
			route = "desconhecida"
		}
		HTTPRequests.WithLabelValues(route, strconv.Itoa(sw.code)).Inc()
		HTTPDuration.WithLabelValues(route).Observe(time.Since(start).Seconds())
	})
}
