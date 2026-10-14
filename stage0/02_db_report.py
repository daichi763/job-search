#!/usr/bin/env python3
# ============================================================
# 段階0-2: 自社DBの現状診断（読み取り専用・VPSで実行）
#
#   ・SQLite を mode=ro（読み取り専用）で開くので、DBは一切変更しない
#   ・確認すること:
#       A. 媒体別の掲載中/掲載終了件数（誤った掲載終了の疑いの確認）
#       B. 同期(trace)の実行履歴・媒体別結果（上限打ち切り/失敗ページ）
#       C. データ品質（ハッシュ未設定・日付項目の有無・重複）
#       D. 検索性能（現行のLIKE検索の実測、FTS5 trigram の可否と速度）
#       E. 容量・インデックス
#   ・D の FTS5 検証は「DBのコピーではなくメモリ上」で行う（本体に索引は作らない）
#
# 使い方:
#   python3 /home/ubuntu/webapp/stage0/02_db_report.py > ~/stage0_db_report.txt
#   （DBの場所を明示する場合）DB_FILE=/path/to.sqlite python3 02_db_report.py
# ============================================================
import glob
import os
import sqlite3
import sys
import time

APP_DIR = os.environ.get("APP_DIR") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
D1_DIR = os.path.join(APP_DIR, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject")
FTS_SAMPLE = int(os.environ.get("FTS_SAMPLE", "30000"))  # FTS検証に使う件数（メモリ上）


def find_db():
    if os.environ.get("DB_FILE"):
        return os.environ["DB_FILE"]
    files = [f for f in glob.glob(os.path.join(D1_DIR, "*.sqlite")) if "metadata" not in os.path.basename(f)]
    if not files:
        sys.exit(f"DBファイルが見つかりません: {D1_DIR}")
    return max(files, key=os.path.getsize)


def h(title):
    print("\n" + "=" * 70 + f"\n{title}\n" + "=" * 70)


def table(rows, headers):
    rows = [["" if v is None else str(v) for v in r] for r in rows]
    w = [max(len(str(x)) for x in col) for col in zip(headers, *rows)] if rows else [len(x) for x in headers]
    print("  ".join(str(x).ljust(w[i]) for i, x in enumerate(headers)))
    print("  ".join("-" * w[i] for i in range(len(headers))))
    for r in rows:
        print("  ".join(x.ljust(w[i]) for i, x in enumerate(r)))


def q(con, sql, args=()):
    try:
        return con.execute(sql, args).fetchall()
    except sqlite3.Error as e:
        print(f"  (SQLエラー: {e})")
        return []


def cols(con, t):
    return [r[1] for r in q(con, f"PRAGMA table_info({t})")]


def timed(con, sql, args=()):
    t = time.perf_counter()
    r = q(con, sql, args)
    return r, (time.perf_counter() - t) * 1000


def main():
    db = find_db()
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
    con.execute("PRAGMA query_only=1")

    h("0. 基本情報")
    print(f"DB: {db}")
    print(f"サイズ: {os.path.getsize(db)/1024/1024:.1f} MB"
          + (f" / WAL: {os.path.getsize(db+'-wal')/1024/1024:.1f} MB" if os.path.exists(db + "-wal") else ""))
    print(f"SQLite: {sqlite3.sqlite_version}  /  Python: {sys.version.split()[0]}")
    print("適用済みマイグレーション:", [r[0] for r in q(con, "SELECT name FROM d1_migrations ORDER BY id")])
    jc = cols(con, "jobs")
    print(f"jobs 列数: {len(jc)}  (trace_sync_at={'trace_sync_at' in jc}, content_hash={'content_hash' in jc})")

    # ---------------- A ----------------
    h("A. 媒体別 件数（掲載中=1 / 掲載終了=0）")
    rows = q(con, """
      SELECT source,
             SUM(is_open=1) open_n, SUM(is_open=0) closed_n, COUNT(*) total,
             SUM(trace_sync_at IS NOT NULL) traced,
             MIN(first_seen_at), MAX(trace_sync_at)
      FROM jobs GROUP BY source ORDER BY source""")
    table(rows, ["source", "掲載中", "掲載終了", "合計", "同期済", "最初の登録", "最終同期確認"])
    for r in rows:
        if r[2] and r[1] is not None and r[2] > r[1]:
            print(f"⚠ {r[0]}: 掲載終了({r[2]:,}) が 掲載中({r[1]:,}) より多い → 誤った掲載終了の可能性が高い")

    print("\n媒体側の総数（最終検索時の記録 source_totals）:")
    table(q(con, "SELECT source,total,updated_at FROM source_totals ORDER BY source"), ["source", "媒体側総数", "記録日時"])

    print("\n掲載終了になった日別件数（直近14日・updated_at基準の目安）:")
    table(q(con, """
      SELECT date(updated_at) d, source, COUNT(*) FROM jobs
      WHERE is_open=0 AND updated_at >= date('now','-14 days')
      GROUP BY d, source ORDER BY d DESC, source"""), ["日付", "source", "掲載終了件数"])

    # ---------------- B ----------------
    h("B. 同期(trace)の実行履歴（直近15回）")
    table(q(con, """
      SELECT substr(id,1,8), trigger, status, started_at, finished_at,
             CAST((julianday(COALESCE(finished_at,datetime('now')))-julianday(started_at))*1440 AS INT) mins,
             total_upserted, total_added, total_closed
      FROM trace_jobs ORDER BY started_at DESC LIMIT 15"""),
          ["id", "起動", "状態", "開始", "終了", "分", "更新", "新規", "掲載終了"])

    tsc = cols(con, "trace_states")
    extra = ", skipped, failed_pages" if "failed_pages" in tsc else ""
    print("\n直近5回の媒体別結果（⚠ 取得数 < 媒体総数 や 失敗ページ>0 は誤った掲載終了の原因）:")
    rows = q(con, f"""
      SELECT substr(ts.trace_job_id,1,8), ts.source, ts.phase, ts.total, ts.fetched,
             ts.upserted, ts.added, ts.closed{extra}, ts.updated_at
      FROM trace_states ts
      WHERE ts.trace_job_id IN (SELECT id FROM trace_jobs ORDER BY started_at DESC LIMIT 5)
      ORDER BY ts.updated_at DESC""")
    hdr = ["job", "source", "phase", "媒体総数", "取得", "更新", "新規", "掲載終了"]
    if extra:
        hdr += ["スキップ", "失敗頁"]
    table(rows, hdr + ["更新日時"])
    warn = [r for r in rows if r[3] and r[4] is not None and r[4] < r[3]]
    if warn:
        print(f"\n⚠ 取得数が媒体総数に届いていない同期が {len(warn)} 件あります（取りこぼし分が掲載終了扱いになった可能性）")

    print("\n実行中のまま残っている同期:")
    table(q(con, "SELECT substr(id,1,8),started_at FROM trace_jobs WHERE status='running'"), ["id", "開始"])

    # ---------------- C ----------------
    h("C. データ品質")
    table(q(con, """
      SELECT source,
        SUM(content_hash IS NULL OR content_hash='') no_hash,
        SUM(source_updated_at IS NOT NULL AND source_updated_at<>'') has_upd,
        SUM(publish_started_at IS NOT NULL AND publish_started_at<>'') has_pub,
        SUM(title IS NULL OR title='') no_title,
        SUM(description IS NULL OR description='') no_desc,
        CAST(AVG(LENGTH(raw_json)) AS INT) raw_avg,
        CAST(AVG(LENGTH(description)) AS INT) desc_avg
      FROM jobs GROUP BY source"""),
          ["source", "ハッシュ無", "媒体更新日有", "掲載開始日有", "タイトル無", "本文無", "raw平均byte", "本文平均"])
    print("\n※「媒体更新日有」が多い媒体ほど、更新日時ベースの差分同期が使える見込み")

    print("\n媒体更新日時の範囲（差分同期の基準に使えるか）:")
    table(q(con, """
      SELECT source, MIN(source_updated_at), MAX(source_updated_at),
             SUM(source_updated_at >= date('now','-1 day')) last1d,
             SUM(source_updated_at >= date('now','-7 day')) last7d
      FROM jobs WHERE is_open=1 AND source_updated_at IS NOT NULL AND source_updated_at<>''
      GROUP BY source"""), ["source", "最古", "最新", "直近1日更新", "直近7日更新"])

    dup = q(con, "SELECT COUNT(*) FROM (SELECT source,source_job_id FROM jobs GROUP BY 1,2 HAVING COUNT(*)>1)")
    print(f"\n重複(source+source_job_id): {dup[0][0] if dup else '?'} 件（0が正常）")

    print("\n他テーブルの件数:")
    for t in ["search_jobs", "search_results", "score_memory", "worker_states", "trace_jobs", "trace_states"]:
        r = q(con, f"SELECT COUNT(*) FROM {t}")
        print(f"  {t}: {r[0][0]:,}" if r else f"  {t}: -")

    # ---------------- D ----------------
    h("D. 検索性能")
    open_n = q(con, "SELECT COUNT(*) FROM jobs WHERE is_open=1")[0][0]
    print(f"掲載中: {open_n:,} 件")
    for kw in ["営業", "エンジニア", "経理"]:
        like = f"%{kw}%"
        r, ms = timed(con, """SELECT COUNT(*) FROM jobs WHERE is_open=1 AND (
             title LIKE ? OR company LIKE ? OR description LIKE ? OR requirements LIKE ?
             OR job_category LIKE ? OR industry LIKE ? OR benefits LIKE ?)""", (like,) * 7)
        print(f"  現行LIKE検索『{kw}』: {r[0][0]:,}件 / {ms:.0f} ms")
    r, ms = timed(con, """SELECT id FROM jobs WHERE is_open=1 AND locations LIKE '%東京%'
                          AND salary_min >= 4000000 ORDER BY updated_at DESC LIMIT 20""")
    print(f"  条件検索（東京×年収400万〜・20件）: {ms:.0f} ms")

    # FTS5 trigram の可否（メモリ上で検証。本体DBには何も作らない）
    mem = sqlite3.connect(":memory:")
    try:
        mem.execute("CREATE VIRTUAL TABLE f USING fts5(title, company, description, requirements, tokenize='trigram')")
        print("\nFTS5 trigram: ✅ 利用可能")
        sample = q(con, f"""SELECT title, company, description, requirements FROM jobs
                            WHERE is_open=1 LIMIT {FTS_SAMPLE}""")
        t = time.perf_counter()
        mem.executemany("INSERT INTO f VALUES (?,?,?,?)", sample)
        build = (time.perf_counter() - t) * 1000
        n = len(sample) or 1
        print(f"  {len(sample):,}件で索引作成 {build:.0f} ms（全{open_n:,}件なら約 {build*open_n/n/1000:.0f} 秒の見込み）")
        mem2 = sqlite3.connect(":memory:")
        mem2.execute("CREATE TABLE j(title,company,description,requirements)")
        mem2.executemany("INSERT INTO j VALUES (?,?,?,?)", sample)
        for kw in ["営業", "エンジニア", "経理"]:
            if len(kw) < 3:
                # trigram は3文字以上で索引が効く。2文字語は LIKE にフォールバックされる
                pass
            r1, ms1 = timed(mem, "SELECT COUNT(*) FROM f WHERE f MATCH ?", (f'"{kw}"',))
            r2, ms2 = timed(mem2, """SELECT COUNT(*) FROM j WHERE title LIKE ? OR company LIKE ?
                                     OR description LIKE ? OR requirements LIKE ?""", (f"%{kw}%",) * 4)
            print(f"  『{kw}』 FTS5: {r1[0][0] if r1 else '-'}件 {ms1:.1f} ms  /  LIKE: {r2[0][0]}件 {ms2:.1f} ms"
                  + ("  ※2文字語はtrigramの索引が効かない" if len(kw) < 3 else ""))
        mem2.close()
    except sqlite3.Error as e:
        print(f"\nFTS5 trigram: ❌ 利用不可 ({e}) → 別方式（bigram索引テーブル等）を検討")
    mem.close()

    # ---------------- E ----------------
    h("E. 容量・インデックス")
    r = q(con, "SELECT page_count*page_size/1024/1024.0, freelist_count*page_size/1024/1024.0 FROM pragma_page_count, pragma_page_size, pragma_freelist_count")
    if r:
        print(f"使用: {r[0][0]:.1f} MB / 未使用領域: {r[0][1]:.1f} MB")
    try:
        rows = q(con, "SELECT name, SUM(pgsize)/1024/1024.0 FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 12")
        table([(a, f"{b:.1f}") for a, b in rows], ["テーブル/索引", "MB"])
    except Exception:
        pass
    print("\njobs のインデックス:", [r[1] for r in q(con, "PRAGMA index_list(jobs)")])

    con.close()
    print("\n--- 診断完了（DBは変更していません）---")


if __name__ == "__main__":
    main()
