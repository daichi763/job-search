# 求人横断検索AI

複数の求人データベースを横断し、AIが求職者の要望に合う求人を一致度順に見つけるアプリ。

## プロジェクト概要
- **名称**: 求人横断検索AI
- **目的**: 4つの求人DBを横断検索し、詳細条件＋フリー記述の要望に対してAIが一致度を採点、最適な求人を効率的に発見する
- **特徴**:
  - 詳細条件入力（勤務地・年収・雇用形態・職種・残業・休日など）＋フリー記述
  - **2段階フィルタリング**でトークンを大幅節約（機械フィルタ→AI採点）
  - AIスタッフ（各DB担当）の稼働状況をリアルタイム可視化
  - 求人は見つかり次第、一致度順に**逐次払い出し**
  - **記憶機能**: 採点結果を記憶し、公開中の求人は次回AIを使わず即提案

## 対象データベース
| # | DB | 種別 | 接続状況 |
|---|----|----|--------|
| ① | circusAGENT | ログイン制Webサービス | フェーズ2（外部ワーカー） |
| ② | ヒトリンク | ログイン制Webサービス | フェーズ2（外部ワーカー） |
| ③ | ジョビンズ | ログイン制Webサービス | フェーズ2（外部ワーカー） |
| ④ | 自社DB (kintone) | REST API | ✅ 接続済み（公開149件 / 全236件） |

## アーキテクチャ
```
[フロント + API]  Cloudflare Pages/Workers + Hono   … 本アプリ
[外部ワーカー]    VPS上の Node ワーカー (worker/) が各DBを検索し ingest API 経由で払い出し
     ├ ①circus : Playwright + 内部REST API（AI検索プランで反復検索）
     ├ ④kintone: 公式REST API（X-Cybozu-API-Token）でAI検索プランのキーワード検索
     │           - 全文相当4フィールド(仕事内容/求人タイトル/応募必須条件/PRポイント)をOR検索
     │           - 公開判定「求人公開=可能」のみ対象（Playwright不要）
     └ ②③: 未実装（アダプタstub）
[記憶]           Cloudflare D1 (求人キャッシュ + AI採点結果の記憶)
[AI採点]         OpenAI gpt-5-nano（採点）/ gpt-5-mini（検索プラン設計・PDF解析）
```

### 検索対象ソースの切替
`worker/.env` の `SOURCES`（カンマ区切り）で有効化。例: `SOURCES=circus,kintone`。
kintone は `KINTONE_SUBDOMAIN` / `KINTONE_APP_ID` / `KINTONE_API_TOKEN` を設定。
kintone も circus と同じ「AI検索プラン反復＋機械フィルタ＋AI採点」フローで動作（絞りすぎ厳禁の方針で勤務地/職種/業種はクエリで絞らず機械フィルタ＋採点に委譲）。

### トークン節約の仕組み
1. **機械フィルタ（消費ゼロ）**: 勤務地/年収/雇用形態などで候補を絞り込み（例: 236件→60件）
2. **AI採点は上位候補のみ**: 機械スコア上位を最大40件、10件ずつバッチ採点
3. **早期終了**: 指定件数(topN)に達したら採点を打ち切り
4. **記憶からの即提案**: 同一要望の再検索は採点済み結果を再利用（トークン0）
5. **フリー記述なしならAI不使用**: 機械スコアのみで払い出し

実測: 初回13秒/約5,800トークン → 同一条件の再検索4秒/**0トークン**

## 機能エントリ（API）
| Method | Path | 説明 |
|--------|------|------|
| GET | `/` | フロントUI |
| POST | `/api/search` | 検索開始（body=検索条件）。`{searchJobId}`を返す |
| GET | `/api/search/:id/status` | 進捗＋各AI担当の状態を取得 |
| GET | `/api/search/:id/results?since=N` | 検索結果を取得（`since`で新着のみ、逐次払い出し用） |
| GET | `/api/stats` | 各DBの総求人数、合計求人数 |
| GET | `/api/ingest/pending?source=X` | (外部ワーカー用) 実行待ちの検索条件を取得 |
| POST | `/api/ingest/state` | (外部ワーカー用) 進捗報告 |
| POST | `/api/ingest/result` | (外部ワーカー用) 求人結果の払い出し |

※ ingest系は `X-Ingest-Token` ヘッダによる認証あり

### 検索条件（POST /api/search body）
```json
{
  "freeText": "未経験から研修充実で成長したい",
  "locations": ["東京都"],
  "salaryMin": 400,
  "employment": ["正社員"],
  "jobCategories": ["ITエンジニア・PM"],
  "overtimeMax": "20時間以下",
  "holiday": ["土日祝休み"],
  "topN": 10,
  "sources": ["kintone", "circus", "hitolink", "jobins"]
}
```

## データモデル（Cloudflare D1）
- `jobs`: 求人キャッシュ（AI担当の記憶。source+source_job_idで一意、公開状態を保持）
- `search_jobs`: 検索ジョブ（1回の検索リクエスト）
- `worker_states`: 各AI担当の稼働状態（可視化用）
- `search_results`: 検索結果（逐次払い出し）
- `score_memory`: AI採点結果の記憶（同一要望の高速再提案用）
- `db_stats`: DB総件数キャッシュ

## 使い方
1. 左パネルで要望（フリー記述）と各種条件を入力
2. 検索対象DBと払い出し件数を選択
3. 「AIスタッフに探してもらう」をクリック
4. 右上でAIスタッフ（各DB担当）の稼働状況をリアルタイム確認
5. マッチした求人が一致度順に逐次表示される（記憶から出た求人には🟡マーク）

## フェーズ2: ①②③スクレイピング（外部ワーカー）
Cloudflareではブラウザ自動操作ができないため、①②③は `worker/` の
Node.js + Playwright プログラムを**手元PC / VPS**で動かして連携します。
詳細は `worker/README.md` を参照。各サイトのセレクタ実装(`worker/adapters.js`)が必要です。

## 開発・起動
```bash
npm install
npm run build
npx wrangler d1 migrations apply webapp-production --local   # D1初期化
pm2 start ecosystem.config.cjs                               # 起動(port 3000)
curl http://localhost:3000/api/stats                         # 動作確認
```

## 環境変数（.dev.vars / 本番はSecret）
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- `KINTONE_SUBDOMAIN`, `KINTONE_APP_ID`, `KINTONE_API_TOKEN`
- `INGEST_TOKEN`（外部ワーカー認証用）

## デプロイ状況
- **プラットフォーム**: Cloudflare Pages
- **状態**: ✅ ローカル稼働中（本番デプロイは未実施）
- **技術スタック**: Hono + TypeScript + Cloudflare D1 + TailwindCSS + OpenAI
- **最終更新**: 2026-07-15

## 今後の推奨ステップ
1. ①②③各サイトのセレクタ実装（`worker/adapters.js`）→ 手元PCで検証
2. 本番デプロイ（Cloudflare Pages）＋ OpenAI/kintone/INGESTトークンをSecret登録
3. 業種条件・福利厚生条件のUI追加（バックエンドは対応済み）
4. 定期同期バッチで記憶を最新化（求人の公開/非公開の反映）
