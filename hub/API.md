# 求人検索API v1 仕様書

4媒体（circus・ヒトリンク・ジョビンズ・自社kintone）の求人約38万件を検索するAPI。
データは毎晩 2:00〜4:00 に更新される（追加・更新・掲載終了・削除）。

## 基本

| 項目 | 内容 |
|---|---|
| URL | `http://133.167.66.111:3000/api/v1/...`（または `https://job-search.dissectera.com/api/v1/...`） |
| 方法 | `GET` のみ。データの変更はできない |
| 形式 | JSON（UTF-8） |
| 認証 | APIキーを設定した場合は必須。`X-API-Key: <キー>` または `Authorization: Bearer <キー>` |
| 回数制限 | 同じ接続元から1分あたり300回（超えると `429`。`Retry-After` 秒待つ） |
| 年収・成果報酬額 | **万円**（例: `salary_min=400` → 400万円以上） |
| 日時 | ISO 8601・UTC（例: `2026-10-15T17:21:00.000Z`） |
| 求人のID | `媒体:媒体の求人ID`（例: `circus:12345`）。毎晩の更新後も変わらない |

### レスポンスの形
```json
// 成功
{ "data": ..., "meta": { ... } }
// 失敗
{ "error": { "code": "bad_request", "message": "per_page は 1〜100 の範囲で指定してください" } }
```

| HTTPコード | code | 意味 |
|---|---|---|
| 200 | | 成功 |
| 400 | `bad_request` | 条件の指定が誤っている（message に理由） |
| 401 | `unauthorized` | APIキーが無い・誤っている |
| 404 | `not_found` | 求人が無い（削除済みなど）／APIが無い |
| 429 | `rate_limited` | 回数制限を超えた |
| 500 | `internal_error` | サーバー側のエラー |
| 502 | `hub_unavailable` | 検索サーバーが停止している |

---

## GET /api/v1/jobs — 求人を検索

| パラメータ | 例 | 内容 |
|---|---|---|
| `q` | `法人営業 未経験` | キーワード。タイトル・会社・職種・仕事内容・応募条件などから探す。空白区切りは「すべて含む」。2文字の語（営業・経理など）も可 |
| `source` | `circus,jobins` | 媒体（`circus` / `hitolink` / `jobins` / `kintone`、カンマで複数） |
| `prefecture` | `東京都,神奈川県` | 都道府県（正式名。カンマで複数＝いずれか）。全国対応の求人は `全国` |
| `salary_min` | `400` | 想定年収の上限がこの金額（万円）以上の求人。年収不明の求人も含む |
| `salary_max` | `800` | 想定年収の下限がこの金額（万円）以下の求人。年収不明の求人も含む |
| `age` | `35` | この年齢で応募できる求人。年齢条件が無い求人も含む |
| `employment` | `正社員,契約社員` | 雇用形態（部分一致。カンマで複数＝いずれか） |
| `category` | `営業,マーケティング` | 職種（部分一致。カンマで複数＝いずれか） |
| `features` | `remote,flex` | 働き方（カンマで複数＝**すべて**満たす）。値は下の「働き方タグ」 |
| `exclude` | `circus:123,jobins:456` | 結果から外す求人ID（紹介済みを外すときなど。最大1000件） |
| `company` | `株式会社` | 会社名（部分一致） |
| `reward_type` | `rate` | 成果報酬の種類（`rate`＝料率 / `fixed`＝固定額） |
| `changed_since` | `2026-10-14T00:00:00+09:00` | この日時以降に内容が変わった（または追加された）求人だけ |
| `status` | `open` | `open`＝掲載中（既定）/ `closed`＝掲載終了（削除待ち）/ `all` |
| `sort` | `updated` | `updated`＝最近変わった順（既定）/ `new`＝新しく取り込んだ順 / `salary_desc`＝年収が高い順 / `salary_asc`＝年収が低い順 |
| `page` | `1` | ページ番号（1から） |
| `per_page` | `20` | 1ページの件数（1〜100、既定20） |
| `fields` | `full` | `full` を指定すると、一覧にも仕事内容など長い項目を含める（遅くなる） |

※ 1万件目より後のページは取得できない。条件を絞って検索する。

### レスポンス例
```json
{
  "data": [
    {
      "id": "circus:12345",
      "source": "circus",
      "source_job_id": "12345",
      "status": "open",
      "title": "法人営業（未経験歓迎）",
      "company": "株式会社サンプル",
      "job_category": "営業・法人営業",
      "job_categories": ["営業", "法人営業"],
      "industry": "IT・通信",
      "employment": "正社員",
      "locations": "東京都港区",
      "salary_min": 400,
      "salary_max": 600,
      "age_min": 20,
      "age_max": 35,
      "gender": null,
      "education": "大卒以上",
      "experience": ["職種未経験OK"],
      "reward": { "type": "rate", "rate": 30, "amount": null, "text": "理論年収の30%" },
      "features": ["remote", "flex"],
      "url": "https://circus-job.com/search/12345",
      "source_published_at": "2026-06-25T05:08:13.000Z",
      "source_updated_at": "2026-10-14T10:21:36.000Z",
      "first_seen_at": "2026-10-14T12:21:30.000Z",
      "last_changed_at": "2026-10-14T12:21:30.000Z",
      "closed_at": null
    }
  ],
  "meta": { "total": 9600, "page": 1, "per_page": 20, "total_pages": 480, "data_updated_at": "2026-10-15T18:35:00.000Z", "took_ms": 120 }
}
```
- `null` は「媒体にその情報が無い」
- `data_updated_at` は最後に同期が終わった日時

### 働き方タグ（`features`）

| 値 | 意味 |
|---|---|
| `remote` | リモート可 |
| `flex` | フレックス |
| `side_job` | 副業可 |
| `no_transfer` | 転勤なし |
| `holidays_120` | 年間休日120日以上 |
| `weekend_off` | 土日祝休み |
| `inexperienced_ok` | 未経験可 |
| `short_time` | 時短勤務可 |

媒体の項目（ヒトリンク・circus の働き方フラグなど）を優先し、無い場合は本文の記述から判定する。
本文からの判定は推定のため、漏れや誤りがありうる。

## GET /api/v1/jobs.csv — 検索結果をCSVで取得

`/api/v1/jobs` と同じパラメータで検索し、CSV（UTF-8・BOM付き。Excelでそのまま開ける）を返す。

| パラメータ | 内容 |
|---|---|
| `limit` | 最大件数（既定1000、最大5000） |
| `ids` | `circus:1,jobins:2` のようにIDを指定すると、その求人だけを出力（検索条件は無視） |

列（24列）：ID・媒体・求人タイトル・会社名・職種・業種・雇用形態・勤務地・年収下限/上限・年齢下限/上限・性別条件・学歴条件・経験・働き方・成果報酬・残業・休日・仕事内容・応募条件・媒体URL・媒体での最終更新・取り込み日時。
ファイル名は `jobs_YYYYMMDDHHMM.csv`。

## GET /api/v1/facets — 検索画面の選択肢

職種の語（件数の多い順に300件）、雇用形態（30件）、働き方タグごとの掲載中件数を返す。

```json
{ "data": { "categories": [ { "value": "営業", "count": 52000 } ],
  "employments": [ { "value": "正社員", "count": 300000 } ],
  "features": [ { "value": "remote", "label": "リモート可", "count": 41000 } ] } }
```

## GET /api/v1/jobs/{id} — 求人の詳細

`{id}` は検索結果の `id`（例: `/api/v1/jobs/circus:12345`）。

一覧の項目に加えて、次の項目を返す。

| 項目 | 内容 |
|---|---|
| `description` | 仕事内容 |
| `requirements` | 応募条件 |
| `benefits` | 福利厚生など |
| `prefectures` | 都道府県（配列） |
| `industries` | 業種（配列） |
| `positions` | 役職・ポジション（配列） |
| `career_stage` | キャリア段階 |
| `company_url` | 会社のWebサイト |
| `overtime` | 残業 |
| `holiday` | 休日 |
| `version` | 内容が変わった回数＋1 |

`?include=raw` を付けると、媒体から取得した元データ（全項目）を `raw` に含める。
元データの項目名は媒体ごとに異なり、媒体側の都合で変わることがある。

## GET /api/v1/sources — 媒体ごとの件数と最終同期

```json
{ "data": [ { "source": "circus", "label": "circus", "open": 157090, "closed": 12,
  "last_sync": { "status": "done", "started_at": "...", "finished_at": "...", "remote_total": 157103, "fetched": 157102,
                 "complete": true, "added": 210, "updated": 1530, "closed": 95, "deleted": 80, "note": null } } ] }
```

## GET /api/v1/prefectures — 都道府県ごとの掲載中件数

`?source=circus` で媒体を絞れる。検索画面の選択肢づくりに使う。

## GET /api/v1/changes — 変更履歴

前回確認したあとに追加・更新・掲載終了・削除された求人を知るためのもの（90日分を保存）。

| パラメータ | 例 | 内容 |
|---|---|---|
| `since` | `2026-10-15T00:00:00+09:00` | この日時以降の変更（既定: 24時間前） |
| `type` | `added,closed` | `added` / `updated` / `closed` / `reopened` / `deleted` |
| `source` | `jobins` | 媒体 |
| `limit` | `100` | 最大件数（1〜1000） |
| `after_id` | `120345` | 続きを取るとき、前回の `meta.next_after_id` を渡す |

```json
{ "data": [ { "change_id": 120346, "id": "jobins:abc", "source": "jobins", "type": "updated",
              "changed_fields": ["salary_max", "description"], "changed_at": "..." } ],
  "meta": { "has_more": true, "next_after_id": 120445 } }
```

---

## 呼び出し例

```bash
curl -H "X-API-Key: <キー>" "http://133.167.66.111:3000/api/v1/jobs?q=法人営業&prefecture=東京都&salary_min=500&age=35"
```

```javascript
const res = await fetch('http://133.167.66.111:3000/api/v1/jobs?' + new URLSearchParams({
  q: '法人営業', prefecture: '東京都', salary_min: '500', per_page: '50',
}), { headers: { 'X-API-Key': process.env.JOB_API_KEY } })
const { data, meta } = await res.json()
```

## 注意
- 毎晩 2:00〜4:00 の更新中も検索できる（結果は更新の途中経過を含む）
- 掲載終了した求人は約1〜2日後に `status=closed`、さらに24時間後に削除される。削除された求人の詳細は `404`
- 媒体側の情報量の差：ヒトリンク・ジョビンズは一覧に業種が無いため `industry` が空のことが多い

## 管理者向け（VPS）
- APIキーの設定: `hub/.env` に `HUB_API_KEYS=キー1,キー2`（未設定なら誰でも使える）→ `pm2 restart hub-api`
- キーの作り方: `openssl rand -hex 24`
- 回数制限: `HUB_API_RATE=300`（1分あたり）
- ブラウザから直接呼ぶ場合の許可元: `HUB_API_CORS_ORIGIN=https://other-app.example.com`（既定は `*`＝どこからでも）
