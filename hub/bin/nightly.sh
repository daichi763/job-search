#!/usr/bin/env bash
# ============================================================
# 毎晩の自動実行（cron から呼ぶ）
#   1. 全媒体を同期（4媒体を同時に読む。05:00 で打ち切り）
#   2. バックアップ（同期の成否に関係なく実行）
#   3. 30日より古いログを削除
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

# cron は PATH が最小限なので、node の場所を補う（node が別の場所なら HUB_NODE_DIR で指定）
export PATH="${HUB_NODE_DIR:-/usr/bin}:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$HUB_DIR" || exit 1
mkdir -p "$HUB_DIR/data"

# 二重起動防止（前日の同期がまだ動いている場合など）
exec 9>"$HUB_DIR/data/nightly.lock"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] 前回の処理が実行中のためスキップ" >> "$LOG"
  exit 0
fi

{
  echo "================ $(date '+%F %T') 毎晩の同期 開始 ================"
  node --no-warnings bin/sync.js --all --trigger=cron
  echo "同期 終了コード: $?"
  node --no-warnings bin/backup.js
  echo "バックアップ 終了コード: $?"
  node --no-warnings bin/status.js
  find "$LOG_DIR" -name 'hub_*.log' -mtime +30 -delete
  echo "================ $(date '+%F %T') 終了 ================"
} >> "$LOG" 2>&1
