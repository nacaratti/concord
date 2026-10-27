"""Gera infra/grafana/dashboards/concord.json. Rode de novo depois de mudar algum painel:
    python infra/grafana/make_dashboard.py
"""
import json
import pathlib

DS = {"type": "prometheus", "uid": "prometheus"}
panels = []
_id = 0


def panel(title, exprs, x, y, w=12, h=8, unit="short", kind="timeseries", desc="", decimals=None):
    global _id
    _id += 1
    p = {
        "id": _id,
        "type": kind,
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [
            {"refId": chr(65 + i), "datasource": DS, "expr": e, "legendFormat": legend}
            for i, (e, legend) in enumerate(exprs)
        ],
        "fieldConfig": {"defaults": {"unit": unit}, "overrides": []},
        "options": {},
    }
    if decimals is not None:
        p["fieldConfig"]["defaults"]["decimals"] = decimals
    if kind == "timeseries":
        p["fieldConfig"]["defaults"]["custom"] = {"lineWidth": 2, "fillOpacity": 10, "showPoints": "never"}
        p["options"] = {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}
    else:
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "value", "graphMode": "area"}
    panels.append(p)


def row(title, y):
    global _id
    _id += 1
    panels.append({"id": _id, "type": "row", "title": title, "collapsed": False, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})


q = lambda p, metric, sel="": f'histogram_quantile({p}, sum by (le) (rate({metric}_bucket{sel}[1m])))'
FANOUT = '{event="MESSAGE_CREATE"}'
POST = '{route="POST /api/channels/{channel}/messages"}'

# Indicadores
panel("Sessões conectadas", [("concord_gateway_sessions_connected", "")], 0, 0, 6, 4, kind="stat")
panel("Entrega de mensagem (p95, fan-out)", [(q(0.95, "concord_gateway_fanout_seconds", FANOUT), "")], 6, 0, 6, 4, "s", "stat",
      "Da publicação do MESSAGE_CREATE até a escrita no socket de cada destinatário. Meta do plano: < 100 ms.")
panel("Mensagens por segundo", [('sum(rate(concord_http_requests_total{route="POST /api/channels/{channel}/messages",code="200"}[1m]))', "")],
      12, 0, 6, 4, "reqps", "stat", decimals=1)
panel("Memória em uso (heap)", [('go_memstats_heap_inuse_bytes{job="concord"}', "")], 18, 0, 6, 4, "bytes", "stat")

row("Gateway", 4)
panel("Sessões", [("concord_gateway_sessions_connected", "conectadas"), ("concord_gateway_sessions_resumable", "caídas, retomáveis")], 0, 5)
panel("Latência de entrega", [
    (q(0.5, "concord_gateway_fanout_seconds", FANOUT), "fan-out p50"),
    (q(0.95, "concord_gateway_fanout_seconds", FANOUT), "fan-out p95"),
    (q(0.99, "concord_gateway_fanout_seconds", FANOUT), "fan-out p99"),
    (q(0.95, "concord_http_request_duration_seconds", POST), "POST da mensagem p95"),
], 12, 5, unit="s", desc="Entrega total no servidor ≈ POST da mensagem + fan-out.")
panel("Eventos entregues por segundo", [("sum by (event) (rate(concord_gateway_events_total[1m]))", "{{event}}")], 0, 13, unit="ops")
panel("Banda enviada pelo gateway", [("sum by (encoding) (rate(concord_gateway_bytes_total[1m]))", "{{encoding}}")], 12, 13, unit="Bps",
      desc="Antes da compressão do WebSocket (permessage-deflate), que corta ~80% disso no fio.")

row("Servidor", 21)
panel("Memória", [('go_memstats_heap_inuse_bytes{job="concord"}', "heap em uso"), ('go_memstats_sys_bytes{job="concord"}', "pedida ao sistema")], 0, 22, unit="bytes")
panel("Goroutines", [('go_goroutines{job="concord"}', "goroutines")], 12, 22)
panel("HTTP: requisições por segundo", [('sum by (route) (rate(concord_http_requests_total{route!="GET /gateway"}[1m]))', "{{route}}")], 0, 30, unit="reqps")
panel("HTTP: p95 por rota", [('histogram_quantile(0.95, sum by (le, route) (rate(concord_http_request_duration_seconds_bucket{route!="GET /gateway"}[1m])))', "{{route}}")],
      12, 30, unit="s")

row("Proteções", 38)
panel("Rate limit: recusas por segundo", [("sum by (rule) (rate(concord_ratelimit_rejected_total[1m]))", "{{rule}}")], 0, 39, unit="ops")
panel("Conexões derrubadas por fila cheia", [("increase(concord_gateway_slow_consumers_total[5m])", "em 5 min")], 12, 39,
      desc="Cliente lento demais para acompanhar os eventos; ele reconecta com RESUME.")

row("Voz (LiveKit)", 47)
panel("Salas e participantes", [("sum(livekit_room_total)", "salas"), ("sum(livekit_participant_total)", "participantes")], 0, 48)
panel("Latência de encaminhamento do SFU (p95)", [('histogram_quantile(0.95, sum by (le) (rate(livekit_forward_latency_ns_bucket[1m])))', "p95")], 12, 48, unit="ns")

dashboard = {
    "uid": "concord",
    "title": "Concord",
    "tags": ["concord"],
    "timezone": "browser",
    "refresh": "5s",
    "time": {"from": "now-15m", "to": "now"},
    "schemaVersion": 39,
    "panels": panels,
}
out = pathlib.Path(__file__).parent / "dashboards" / "concord.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(dashboard, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{out} ({len([p for p in panels if p['type'] != 'row'])} painéis)")
