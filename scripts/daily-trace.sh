#!/usr/bin/env bash
# ============================================================
# 日次全求人同期（cron用）
#   VPS上でこのスクリプトを毎日1回実行する。
#   webappの /api/trace/start を叩いてトレースジョブを作成し、
#   常駐ワーカーの trace ループが拾って4DBの全求人を自社DBへ同期する。
#
# セットアップ例（VPSで crontab -e）:
#   # 毎日 午前4時に全件同期
#   0 4 * * * /home/ubuntu/webapp/scripts/daily-trace.sh >> /home/ubuntu/webapp/logs/daily-trace.log 2>&1
#
# 環境変数（未指定時は既定値）:
#   APP_URL       … webappのURL（既定: http://127.0.0.1:3000）
#   TRACE_SOURCES … 同期対象媒体（既定: 全4媒体。省略でサーバ側の既定=全媒体）
# ============================================================
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:3000}"

# 対象媒体（カンマ区切り環境変数 → JSON配列）。未指定なら全媒体をサーバ既定に任せる。
BODY='{"trigger":"cron"}'
if [ -n "${TRACE_SOURCES:-}" ]; then
  # circus,hitolink → ["circus","hitolink"]
  ARR=$(printf '%s' "$TRACE_SOURCES" | awk -F, '{for(i=1;i<=NF;i++){printf (i>1?",":"") "\"" $i "\""}}')
  BODY="{\"trigger\":\"cron\",\"sources\":[${ARR}]}"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 日次同期を開始します APP_URL=${APP_URL}"
RESP=$(curl -sS -X POST "${APP_URL}/api/trace/start" \
  -H "Content-Type: application/json" \
  -d "${BODY}")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] レスポンス: ${RESP}"

# traceJobId を取り出して進捗を数分監視（任意）。ログに完了サマリを残す。
TRACE_ID=$(printf '%s' "$RESP" | sed -n 's/.*"traceJobId":"\([^"]*\)".*/\1/p')
if [ -z "$TRACE_ID" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] traceJobId を取得できませんでした（既に実行中の可能性）。終了します。"
  exit 0
fi

# 最大30分、30秒ごとに状態を確認
for i in $(seq 1 60); do
  sleep 30
  ST=$(curl -sS "${APP_URL}/api/trace/status?id=${TRACE_ID}")
  STATUS=$(printf '%s' "$ST" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 同期完了 status=${STATUS}"
    echo "$ST"
    exit 0
  fi
done
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 監視タイムアウト（同期はバックグラウンドで継続中の可能性）。"
