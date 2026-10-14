#!/usr/bin/env bash
# ============================================================
# 毎晩の自動実行（cron から呼ぶ）
#   1. 全媒体を同期（4媒体を同時に読む。05:00 で打ち切り）
#   2. バックアップ（同期の成否に関係なく実行）
#   3. 30日より古いログを削除
#
# 動作確認用: 媒体を指定すると、その媒体だけ同期する（例: bash bin/nightly.sh kintone）
#
# cron 設定（crontab -e）:
#   0 2 * * * /home/ubuntu/webapp/hub/bin/nightly.sh
# ログ: /home/ubuntu/webapp/logs/hub/hub_YYYY-MM-DD.log
# ============================================================
set -u
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HUB_DIR/../logs/hub"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/hub_$(date +%F).log"

# cron は PATH が最小限なので、Node.js 22 以上を探して使う
#   （node:sqlite が必要。古い Node.js が先に見つかると動かない）
#   見つからない場合は hub/.env か crontab で HUB_NODE=/path/to/node を指定する
find_node() {
  for n in "${HUB_NODE:-}" "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node \
           "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] || continue
    major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
    [ "${major:-0}" -ge 22 ] && { echo "$n"; return 0; }
  done
  return 1
}
cd "$HUB_DIR" || exit 1
mkdir -p "$HUB_DIR/data"

# 二重起動防止（前日の同期がまだ動いている場合など）
exec 9>"$HUB_DIR/data/nightly.lock"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] 前回の処理が実行中のためスキップ" >> "$LOG"
  exit 0
fi

NODE="$(find_node)" || { echo "[$(date '+%F %T')] Node.js 22 以上が見つかりません（HUB_NODE で指定してください）" >> "$LOG"; exit 1; }

{
  echo "================ $(date '+%F %T') 毎晩の同期 開始（node $("$NODE" -v)） ================"
  if [ "$#" -gt 0 ]; then
    "$NODE" --no-warnings bin/sync.js "$@" --trigger=cron
  else
    "$NODE" --no-warnings bin/sync.js --all --trigger=cron
  fi
  echo "同期 終了コード: $?"
  "$NODE" --no-warnings bin/backup.js
  echo "バックアップ 終了コード: $?"
  "$NODE" --no-warnings bin/status.js
  find "$LOG_DIR" -name 'hub_*.log' -mtime +30 -delete
  echo "================ $(date '+%F %T') 終了 ================"
} >> "$LOG" 2>&1
