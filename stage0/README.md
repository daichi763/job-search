# 段階0：現状調査とバックアップ（VPSで実行する手順書）

> この段階では **アプリのコード・DB・設定は一切変更しません。** 
> 実行するのは「バックアップ」「DBの読み取り」「媒体への検索（読み取り）」だけです。

| スクリプト | 内容 | 所要時間の目安 | 影響 |
|---|---|---|---|
| `stage0/01_backup.sh` | DB（稼働中のまま安全に取得）と設定ファイルのバックアップ | 1〜3分 | なし |
| `stage0/02_db_report.py` | DBの現状診断（件数・同期履歴・データ品質・検索速度） | 1〜2分 | なし（読み取り専用で開く） |
| `worker/stage0_probe_sources.js` | 各媒体で「差分同期に使える並び順」「深いページの取得可否」などを調べる | 10〜20分 | 媒体への検索のみ。**実行中は常駐workerを止める** |

---

## 手順

### 0. コードを取得（アプリは再起動しない）
```bash
cd /home/ubuntu/webapp
git pull origin main
```
※ `git pull` で増えるのは `stage0/` と `worker/stage0_probe_sources.js` だけです。
　`npm run build` も `pm2 restart` も **不要** です（稼働中のアプリには影響しません）。

### 1. バックアップ（いつ実行してもOK）
```bash
bash /home/ubuntu/webapp/stage0/01_backup.sh
```
- `~/backups/webapp/` に `jobs_db_日時.sqlite.gz`、`config_日時.tar.gz`、`crontab_日時.txt` が作られます
- 最後に `integrity_check=ok` と表示されれば成功です
- 可能であれば手元PCにもコピーしてください（VPS故障への備え）

### 2. DB診断（いつ実行してもOK）
```bash
python3 /home/ubuntu/webapp/stage0/02_db_report.py | tee ~/stage0_db_report.txt
```

### 3. 媒体API調査（AI検索を使っていない時間帯に実行）
circus は同時ログインが1セッションまでのため、調査中は常駐workerを止めます。
（止めている間、AI検索の circus／ヒトリンク／ジョビンズは使えません。kintone と画面は動きます）

```bash
cd /home/ubuntu/webapp/worker
pm2 stop worker                                   # 常駐workerを一時停止
node stage0_probe_sources.js | tee ~/stage0_probe_log.txt
pm2 start worker                                  # 必ず再開する
pm2 logs worker --lines 30 --nostream             # 再ログインできたか確認
```
- 途中でエラーになっても、**必ず `pm2 start worker` を実行してください**
- 媒体を絞る場合: `node stage0_probe_sources.js kintone jobins`
- 結果は `~/stage0_probe_日時.json` に保存されます

### 4. 結果を共有
次の3ファイルの内容を共有してください（パスワード等は含まれません）。
```
~/stage0_db_report.txt
~/stage0_probe_log.txt
~/stage0_probe_*.json
```
※ JSON は大きい場合があります。`ls -lh ~/stage0_probe_*.json` で確認し、
　大きければ `gzip` して共有してください。

---

## 調査で判断すること

| 確認項目 | 判断に使う箇所 | 次の段階への影響 |
|---|---|---|
| 誤った掲載終了が起きているか | 診断 A・B（掲載終了 > 掲載中、取得数 < 媒体総数） | 起きていれば段階2の前に応急修正を優先 |
| 更新日時の新しい順に並べられるか | 調査サマリ「日付降順にできた並び順」 | できる媒体は「前回以降の分だけ読む」差分同期 |
| 深いページが取れるか | 調査サマリ「深いページ」が0件か | 取れない媒体は分割取得（都道府県別など）が必須 |
| 分類別の件数が取れるか | circus の `prefectureCounts` | 削除検知を「件数がずれた分類だけ読み直す」方式にできるか |
| 全文検索（FTS5）が使えるか・速いか | 診断 D | 検索APIの方式決定 |
