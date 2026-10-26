package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"concord/internal/api"
	"concord/internal/gateway"
	"concord/internal/ratelimit"
	"concord/internal/snowflake"
	"concord/internal/store"
	"concord/internal/voice"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, env("DATABASE_URL", "postgres://concord:concord@localhost:5433/concord?sslmode=disable"))
	if err != nil {
		log.Error("conectar ao postgres", "err", err)
		os.Exit(1)
	}
	if err := st.Migrate(ctx); err != nil {
		log.Error("migrações", "err", err)
		os.Exit(1)
	}

	ropts, err := redis.ParseURL(env("REDIS_URL", "redis://localhost:6380/0"))
	if err != nil {
		log.Error("REDIS_URL inválida", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(ropts)
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Warn("redis indisponível: rate limit fica desligado até ele voltar", "err", err)
	}
	limiter := ratelimit.New(rdb, log)
	trustProxy := os.Getenv("CONCORD_TRUST_PROXY") == "1"

	origins := strings.Split(env("CONCORD_ORIGINS", "localhost:*,127.0.0.1:*"), ",")
	hub := gateway.NewHub(st, log, origins)
	vc := &voice.Config{
		APIKey:    env("LIVEKIT_API_KEY", "concord-dev"),
		APISecret: env("LIVEKIT_API_SECRET", "concord-dev-secret-troque-em-producao-0123456789"),
		PublicURL: env("LIVEKIT_PUBLIC_URL", "ws://localhost:7880"),
	}
	hub.Limiter, hub.TrustProxy, hub.Voice = limiter, trustProxy, vc
	go hub.Run(ctx)

	a := &api.API{Store: st, Hub: hub, IDs: snowflake.NewGenerator(1), Limiter: limiter, Voice: vc, Log: log, TrustProxy: trustProxy}
	mux := http.NewServeMux()
	mux.Handle("/api/", a.Routes())
	mux.Handle("GET /gateway", hub)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	if dir := os.Getenv("CONCORD_WEB_DIR"); dir != "" {
		mux.Handle("/", spa(dir))
	}

	srv := &http.Server{Addr: env("CONCORD_ADDR", ":8080"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("concord ouvindo", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("servidor", "err", err)
		os.Exit(1)
	}
}

// spa serve o build do cliente web, caindo no index.html para rotas do lado do cliente (ex.: /invite/abc).
func spa(dir string) http.Handler {
	fsrv := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(dir + r.URL.Path); err != nil || r.URL.Path == "/" {
			http.ServeFile(w, r, dir+"/index.html")
			return
		}
		fsrv.ServeHTTP(w, r)
	})
}
