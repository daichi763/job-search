# 求人データハブ（hub/）

各媒体の全求人を **自社DB（SQLite）に保持** し、毎日 **追加・更新・掲載終了・削除だけ** を反映する仕組み。
既存アプリ（webapp / worker）とは **完全に独立** しており、既存アプリのDB・コード・PM2設定には一切触れない。

- DB: `hub/data/jobs_hub.sqlite`（既存アプリのDBとは別ファイル。git管理外）
- 媒体のログイン情報: 既存の `worker/.env` をそのまま読む（二重管理しない）
- ログイン・API呼び出し・データ変換: 既存の `worker/adapters.js` をそのまま使う
- 依存パッケージ: 追加なし（Node.js 22 標準の `node:sqlite` ＋ worker の playwright / dotenv を借用）

## 対応状況（段階1）

| 媒体 | 状態 | 読み方 |
|---|---|---|
| kintone | ✅ | `$id` 昇順カーソルで全件（数秒） |
| ヒトリンク | ✅ | 1,000件ずつ全ページ（約6〜10分の見込み） |
| ジョビンズ | 段階2 | |
| circus | 段階2 | |

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

## 既存アプリとの関係
- 同期中に既存アプリでAI検索が実行中なら、終わるまで待つ（最大30分。circus/ヒトリンクの同時ログイン競合を避けるため）
- 二重起動は `hub/data/sync.lock` で防止
- ヒトリンクは既存 worker と同じアカウントでログインする。深夜2〜5時はAI検索を使わない運用とする
