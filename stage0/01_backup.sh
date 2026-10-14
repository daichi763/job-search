#!/usr/bin/env bash
# ============================================================
# 段階0-1: DBと設定ファイルのバックアップ（VPSで実行）
#
#   ・稼働中のままで安全に取れる「SQLiteオンラインバックアップ」を使う
#     （ファイルを cp するとWAL書き込み途中の壊れたコピーになる恐れがあるため）
#   ・バックアップ後に integrity_check で壊れていないことを検証する
#   ・アプリ／DBには一切書き込まない
#
# 使い方:
#   bash /home/ubuntu/webapp/stage0/01_backup.sh
#   （任意）BACKUP_DIR=/path/to/dir bash .../01_backup.sh
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/webapp}"
STAMP="$(date '+%Y-%m-%d_%H%M%S')"
D1_DIR="$APP_DIR/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 本体DB = metadata 以外で最大の .sqlite
DB_FILE="$(ls -S "$D1_DIR"/*.sqlite 2>/dev/null | grep -v metadata | head -1 || true)"
if [ -z "$DB_FILE" ]; then
  echo "❌ DBファイルが見つかりません: $D1_DIR" >&2
  exit 1
fi
echo "対象DB: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"

OUT_DB="$BACKUP_DIR/jobs_db_${STAMP}.sqlite"

python3 - "$DB_FILE" "$OUT_DB" <<'PY'
import sqlite3, sys, time
src_path, dst_path = sys.argv[1], sys.argv[2]
t = time.time()
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=30)
dst = sqlite3.connect(dst_path)
# pages=1000 ずつコピー → 稼働中アプリの書き込みを長時間ブロックしない
src.backup(dst, pages=1000, sleep=0.05)
src.close()
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
n = dst.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
dst.close()
print(f"バックアップ完了 {time.time()-t:.1f}秒 / integrity_check={ok} / jobs={n:,}件")
if ok != "ok":
    sys.exit(2)
PY

gzip -f "$OUT_DB"
chmod 600 "$OUT_DB.gz"
echo "✅ DB: $OUT_DB.gz ($(du -h "$OUT_DB.gz" | cut -f1))"

# 設定ファイル（パスワード等を含むため権限600で別ファイルに保存）
CONF_TAR="$BACKUP_DIR/config_${STAMP}.tar.gz"
( cd "$APP_DIR" && tar -czf "$CONF_TAR" \
    $( [ -f .dev.vars ] && echo .dev.vars ) \
    $( [ -f worker/.env ] && echo worker/.env ) \
    ecosystem.config.cjs wrangler.jsonc 2>/dev/null ) || true
chmod 600 "$CONF_TAR" 2>/dev/null || true
echo "✅ 設定: $CONF_TAR"

# crontab も記録（日次同期の設定確認用）
crontab -l > "$BACKUP_DIR/crontab_${STAMP}.txt" 2>/dev/null || echo "(crontab なし)" > "$BACKUP_DIR/crontab_${STAMP}.txt"

echo
echo "空き容量:"; df -h "$BACKUP_DIR" | tail -1
echo
echo "⚠ 可能であれば、このバックアップをVPS外（手元PC等）にもコピーしてください:"
echo "   scp ubuntu@<VPSのIP>:$OUT_DB.gz ."
