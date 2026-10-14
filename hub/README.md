# 求人データハブ（hub/）

各媒体の全求人を **自社DB（SQLite）に保持** し、毎日 **追加・更新・掲載終了・削除だけ** を反映する仕組み。
既存アプリ（webapp / worker）とは **完全に独立** しており、既存アプリのDB・コード・PM2設定には一切触れない。

- DB: `hub/data/jobs_hub.sqlite`（既存アプリのDBとは別ファイル。git管理外）
- 媒体のログイン情報: 既存の `worker/.env` をそのまま読む（二重管理しない）
- ログイン・API呼び出し・データ変換: 既存の `worker/adapters.js` をそのまま使う
- 依存パッケージ: 追加なし（Node.js 22 標準の `node:sqlite` ＋ worker の playwright / dotenv を借用）

## 対応状況（段階2）

| 媒体 | 状態 | 読み方 | 所要時間 |
|---|---|---|---|
| kintone | ✅ VPSで確認済み | `$id` 昇順カーソルで全件 | 数秒 |
| ヒトリンク | ✅ VPSで確認済み（107,222件） | 1,000件ずつ全ページ | 約9分 |
| ジョビンズ | 段階2で追加 | 100件ずつ全ページ（上限100件） | 約40分の見込み |
| circus | 段階2で追加 | 200件ずつ・掲載開始日の新しい順 | 約1.5時間の見込み |

4媒体は別のサイトなので **同時に** 読む。全体の所要時間は一番遅い circus で決まる。

## 同期の考え方

毎回、媒体の一覧を **全件読む** → DBと比べて変わったものだけ書く。

| 判定 | 条件 | DBへの書き込み |
|---|---|---|
| 追加 | 初めて見た求人 | 追加 |
| 更新 | 内容（タイトル・年収・本文など）が変わった | 更新＋変わった項目名を履歴に記録 |
| 軽更新 | 内容は同じで、媒体の更新日時・元データだけ変わった | 日時と元データだけ更新 |
| 変化なし | すべて同じ | 書き込まない |
| 再掲載 | 掲載終了だった求人が再び一覧に出た | 掲載中に戻す |
| 掲載終了 | 一覧に **2回連続** で無かった（kintoneは1回） | 掲載終了にする（検索に出なくなる） |
| 削除 | 掲載終了から **24時間** 経過 | 物理削除 |

### 取れなかったページの取り直し
媒体側の一時的なエラーで取れなかったページは、最後に自動で取り直す。
1. 30秒待って同じページをもう一度 → 2. 25件ずつに分けて → 3. それでも駄目な部分は1件ずつ
最後まで取れない求人が1件でも残った回は「読み切れていない」扱い（`HUB_MAX_UNREADABLE` で許容件数を変更可）。

### 掲載終了の安全装置
- 最後まで読み切れなかった回（ページ取得失敗・時間切れ・取得数が媒体総数の98%未満）は **判定しない**
- 1回で全体の **5%** を超えて消えた場合は **判定を保留**（記録だけ残す）

## DBの構成

| テーブル | 内容 |
|---|---|
| `jobs` | 検索・絞り込み用の項目（タイトル・会社・職種・年収・年齢・成果報酬など） |
| `job_texts` | 仕事内容・応募条件など長い文章 |
| `job_raw` | 媒体の元データ（JSONそのまま。一覧に出ている全項目） |
| `job_prefectures` | 勤務地の都道府県（複数可） |
| `jobs_fts` | 全文検索の索引（2文字単位。「営業」「経理」など2文字語も高速） |
| `job_changes` | 変更履歴（追加/更新/掲載終了/再掲載/削除、90日保存） |
| `sync_runs` | 同期の実行記録（媒体ごと・回ごとの件数、完走したか、注意事項） |

## コマンド（VPS: `cd /home/ubuntu/webapp/hub`）

```bash
node --no-warnings bin/sync.js kintone hitolink --deadline=none   # 手動で同期（時間制限なし）
node --no-warnings bin/sync.js --all --trigger=cron                # cron 用（05:00 で打ち切り）
node --no-warnings bin/status.js                                   # 状況の確認（読み取りのみ）
node --no-warnings bin/search.js 営業 --prefecture=東京都 --salaryMin=4000000   # 検索の確認
node --no-warnings bin/search.js --bench                           # 検索速度の測定
node --no-warnings bin/backup.js                                   # バックアップ（~/backups/hub に3世代）
bash bin/nightly.sh                                                # 毎晩の処理（同期→バックアップ）を手動で実行
node --no-warnings --test test/*.test.js                           # 自動テスト（媒体に接続しない）
```

検索の条件: `--prefecture=東京都,大阪府` `--salaryMin=円` `--salaryMax=円` `--age=歳` `--source=hitolink`
`--employment=正社員` `--category=営業` `--sort=updated|new|salary_desc|salary_asc` `--limit=20` `--offset=0`

## 設定（任意: `hub/.env`）

| 変数 | 既定 | 内容 |
|---|---|---|
| `HUB_DB_PATH` | `hub/data/jobs_hub.sqlite` | DBの場所 |
| `HUB_SYNC_DEADLINE` | `05:00` | この時刻で取得を打ち切る（打ち切った回は掲載終了の判定をしない） |
| `HUB_CLOSE_AFTER_MISSES` | `2` | 何回連続で一覧に無ければ掲載終了か |
| `HUB_DELETE_AFTER_HOURS` | `24` | 掲載終了から削除までの時間 |
| `HUB_MAX_CLOSE_RATIO` | `0.05` | 1回で消えてよい割合の上限 |
| `HUB_COMPLETE_RATIO` | `0.98` | 媒体総数に対して何割取れたら「読み切れた」とみなすか |
| `HUB_HITOLINK_PAGE_SIZE` | `1000` | ヒトリンクの1回の取得件数 |
| `HUB_PAGE_DELAY_MS` | `500` | ページ間の待機（媒体への負荷軽減） |
| `HUB_CIRCUS_PAGE_SIZE` | `200` | circus の1回の取得件数 |
| `HUB_CIRCUS_ORDER_BY` | `publishStartedAt` | circus の並び順（おすすめ順は読んでいる間に順位が変わるため使わない） |
| `HUB_RECOVER_WAIT_MS` | `30000` | 取り直す前に待つ時間 |
| `HUB_RECOVER_CHUNK` | `25` | 取り直しで小分けにする件数 |
| `HUB_MAX_UNREADABLE` | `0` | どうしても取れない求人がこの件数以下なら「読み切れた」とみなす |
| `HUB_BACKUP_DIR` | `~/backups/hub` | バックアップの保存先 |
| `HUB_BACKUP_KEEP` | `3` | バックアップを何世代残すか |

## 毎晩の自動実行（cron）

```bash
crontab -e
# 次の1行を追加（毎日 2:00 に開始。同期は 5:00 で打ち切り）
0 2 * * * /home/ubuntu/webapp/hub/bin/nightly.sh
```
- ログ: `/home/ubuntu/webapp/logs/hub/hub_YYYY-MM-DD.log`（30日で自動削除）
- 前日の処理がまだ動いていれば、その日はスキップする
- 時間切れで読み切れなかった媒体は、掲載終了の判定をしない（翌日に持ち越し）

## バックアップからの復元
```bash
cd /home/ubuntu/webapp/hub
mv data/jobs_hub.sqlite data/jobs_hub.sqlite.broken
zcat ~/backups/hub/jobs_hub_YYYY-MM-DD_HHMM.sqlite.gz > data/jobs_hub.sqlite
node --no-warnings bin/status.js
```

## 既存アプリとの関係
- 同期中に既存アプリでAI検索が実行中なら、終わるまで待つ（最大30分。circus/ヒトリンクの同時ログイン競合を避けるため）
- 二重起動は `hub/data/sync.lock` で防止
- ヒトリンクは既存 worker と同じアカウントでログインする。深夜2〜5時はAI検索を使わない運用とする
