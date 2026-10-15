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
最後まで取れない求人が5件を超えた回は「読み切れていない」扱い（`HUB_MAX_UNREADABLE` で変更可）。circus には媒体側の不具合でどうしても取得できない求人が1件ある（2026-10-15確認）。

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
| `job_features` | 働き方タグ（リモート可・フレックス・副業可・転勤なし・年休120日以上・土日祝休み・未経験可・時短勤務可） |
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
node --no-warnings bin/features.js                                 # 既存の求人へ働き方タグを付け直す（判定ルールを変えたとき。同期中は不可）
node --no-warnings --test test/*.test.js                           # 自動テスト（媒体に接続しない）
```

検索の条件: `--prefecture=東京都,大阪府` `--salaryMin=円` `--salaryMax=円` `--age=歳` `--source=hitolink`
`--employment=正社員,契約社員` `--category=営業,企画`（カンマ＝いずれか） `--features=remote,flex`（すべて満たす） `--sort=updated|new|salary_desc|salary_asc` `--limit=20` `--offset=0`

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
| `HUB_REQUEST_TIMEOUT_MS` | `90000` | 1回の通信の上限時間（媒体が応答しないまま固まるのを防ぐ） |
| `HUB_RECOVER_WAIT_MS` | `30000` | 取り直す前に待つ時間 |
| `HUB_RECOVER_CHUNK` | `25` | 取り直しで小分けにする件数 |
| `HUB_MAX_UNREADABLE` | `5` | どうしても取れない求人がこの件数以下なら「読み切れた」とみなす |
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

## 手動検索画面（既存アプリの /manual）

既存アプリ（3000番）のトップ右上「手動検索モード」→ `/manual` で、このハブDBを検索できる。
```
ブラウザ ──▶ webapp（3000番）/manual, /hub-api/api/* ──中継──▶ hub-api（127.0.0.1:3100・サーバー内部専用）──▶ hub DB（読み取り専用）
```
- hub-api は PM2 の `ecosystem.config.cjs` に登録済み（`pm2 start ecosystem.config.cjs --only hub-api`）
- hub-api は 127.0.0.1 でだけ待ち受けるので、外から 3100番に直接はつながらない
- hub-api が止まっていると `/manual` は「接続できません」の案内を表示する（AI検索は影響なし）
- 旧・手動検索画面は `/manual-old`（切り戻し用。新画面が安定したら削除）
- 中継先は `.dev.vars` の `HUB_API_URL` で変更可（既定 `http://127.0.0.1:3100`）

| API（読み取りのみ） | 内容 |
|---|---|
| `GET /hub-api/api/overview` | 媒体別件数・最終同期・都道府県一覧 |
| `GET /hub-api/api/jobs?keyword=&source=&prefecture=&salaryMin=&age=&company=&employment=&rewardType=&status=&sort=&limit=&offset=` | 検索 |
| `GET /hub-api/api/jobs/:id` | 求人の詳細（元データ・変更履歴を含む） |

※ hub-api を単体で外部公開する場合のみ `HUB_HOST=0.0.0.0` と `HUB_VIEWER_PASSWORD`（必須）を hub/.env に設定する。

## 外部向け検索API v1（別アプリ用）

仕様書: **[API.md](./API.md)**

- URL: `http://<VPS>:3000/api/v1/jobs?q=営業&prefecture=東京都&salary_min=400`（webapp が hub-api へ中継）
- APIキー: `hub/.env` の `HUB_API_KEYS`（カンマ区切り・未設定なら鍵なし）。設定後 `pm2 restart hub-api`
- 速度の目安（38万件規模の試験データ）: キーワード検索 0.1〜0.35秒。同じ条件の2ページ目以降は件数を数え直さないので速い

## 既存アプリとの関係
- 同期中に既存アプリでAI検索が実行中なら、終わるまで待つ（最大30分。circus/ヒトリンクの同時ログイン競合を避けるため）
- 二重起動は `hub/data/sync.lock` で防止
- ヒトリンクは既存 worker と同じアカウントでログインする。深夜2〜5時はAI検索を使わない運用とする

## AI検索エンジン（新方式・評価中）

求人DB（このハブ）の全求人を母集団として、AIが求職者に合う求人を探す。媒体には直接ログインしない。
**今は評価用のコマンドだけで、画面・稼働中のAI検索には組み込んでいない**（Phase 2〜3 で組み込む）。

### 仕組み（4段階）
| 段階 | 内容 | モデル |
|---|---|---|
| 1. 理解 | 要望と書類の経歴から「探し方の切り口」（王道・発展・意外）とキーワードを作る | 優秀（`HUB_AI_MODEL_SMART`） |
| 2. 絞込 | 確定条件（勤務地・年齢・年収・雇用形態・働き方・学歴・性別・紹介済み除外）で全求人から母集団を作り、切り口のキーワードで関連の強い順に並べる | なし（DB検索・数秒） |
| 3. 一次審査 | 関連の強い順に 2,000件（徹底: 8,000件 / 全件）を、安いモデルで「要望の中心に沿うか・必須要件を満たしそうか」まで素早く審査 | 高速（`HUB_AI_MODEL_FAST`） |
| 4. 精査 | 有望な上位（最大120件）の求人票を**全文**で読み、必須要件を1つずつ ○（満たす）×（満たさない）？（不明）で判定 | 優秀（最高精度を選ぶと `HUB_AI_MODEL_TOP`） |

**85点問題の対策**: 点数はAIの採点をそのまま使わず、必須要件の判定で上限をかける。
- 必須要件に × が1つでもあれば **55点まで**（提案から外し、「参考」に回す）
- 書類があるのに ？ が残る場合は **84点まで**（応募前に確認すべき点として表示）
- 学歴・性別の条件は AI に任せず、プログラムで確実に除外する

### 評価のしかた（VPS）
```bash
cd /home/ubuntu/webapp/hub
# まずAIを使わずに母集団の件数だけ確認
node --no-warnings bin/ai-search.js --text="要望" --locations=東京都 --age=30 --dry
# 本番
node --no-warnings bin/ai-search.js \
  --text="顧客を長く支援する仕事がしたい。転勤は避けたい" \
  --doc=cv:/home/ubuntu/test/職務経歴書.pdf --doc=resume:/home/ubuntu/test/履歴書.pdf --names="山田 太郎" \
  --locations=東京都,神奈川県 --age=31 --education=大卒 --salaryMin=500 --top=20
```
| オプション | 内容 |
|---|---|
| `--doc=種類:パス` | 書類（PDF）。種類は `resume`（履歴書）/ `cv`（職務経歴書）/ `other`。複数指定可 |
| `--names=` | 求職者の氏名（書類の本文から伏せるため。AIには送らない） |
| `--features=remote,flex` | 働き方（すべて満たす） |
| `--category=` `--employment=` `--source=` | 職種・雇用形態・媒体（カンマで複数） |
| `--exclude=circus:1,jobins:2` | 除外する求人（紹介済みなど） |
| `--jobs=circus:1,...` | この求人だけを審査（手動検索で選んだ求人をAIにかける想定。120件以内なら一次審査を飛ばして全件精査） |
| `--depth=standard / deep / all` | 一次審査の件数（2,000 / 8,000 / 全件） |
| `--precision=top` | 精査を最高精度モデルで行う |

結果は画面に表示し、`hub/data/ai-results/` にJSONで保存する（必須要件の判定・懸念点・確認事項・一次審査の点数をすべて含む）。

### モデルの設定（`hub/.env`。未設定なら既定値）
```
HUB_AI_MODEL_SMART=gpt-6.1-sol      # 理解・書類の読み取り・精査
HUB_AI_MODEL_TOP=gpt-6-astra        # 「最高精度」の精査
HUB_AI_MODEL_FAST=gpt-6-luna        # 一次審査
HUB_AI_FALLBACK_MODELS=gpt-5.5,gpt-5.2,gpt-5   # 上が使えないときに順に試す
HUB_AI_FALLBACK_FAST_MODELS=gpt-5-mini,gpt-5-nano
# APIキーは worker/.env の OPENAI_API_KEY を使う（別にしたい場合は HUB_AI_API_KEY / HUB_AI_BASE_URL）
```
使えないモデル（契約・提供状況）は自動で次の候補に切り替わり、ログに表示される。
件数や点数の上限は `HUB_AI_SCREEN_STANDARD` `HUB_AI_DEEP_MAX` `HUB_AI_CAP_UNMET` などで調整できる（`lib/ai/engine.js` の `engineConfig`）。

## AI検索（新方式）
求人DBの全求人からAIが探す新しい検索エンジンと評価コマンドは **[AI.md](./AI.md)** を参照。
