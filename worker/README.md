# 外部スクレイピングワーカー（フェーズ2）

①circusAGENT ②ヒトリンク ③ジョビンズ にログインしてスクレイピングし、
Cloudflare側アプリへ求人を逐次払い出す **手元PC / VPS 用のNode.jsプログラム**です。

Cloudflare Workers/Pages ではブラウザ自動操作ができないため、この部分だけ別サーバーで動かします。

## セットアップ（手元PCで検証）

```bash
cd worker
cp .env.example .env      # 値を設定（下記参照）
npm install               # Playwright と Chromium を自動ダウンロード
npm run start:once        # まず1回だけ実行して動作確認
npm start                 # 問題なければ常駐ポーリング
```

## .env の設定

| 変数 | 説明 |
|------|------|
| `APP_URL` | Cloudflare側アプリのURL（ローカル検証中は `http://localhost:3000`。ただし手元PCから見えるURLである必要あり。デプロイ後は `https://xxx.pages.dev`） |
| `INGEST_TOKEN` | 取り込みAPIの認証トークン。**Cloudflare側の設定値と一致させる** |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | 採点用LLM |
| `CIRCUS_*` / `HITOLINK_*` / `JOBINS_*` | 各サイトのログイン情報 |
| `HEADLESS` | `false` にするとブラウザ画面が表示され、セレクタ調整に便利 |

## ⚠️ 実装が必要な箇所

`adapters.js` の各サイトの `login()` と `fetchJobs()` は **雛形（テンプレート）** です。
各サイトのHTML構造に合わせてセレクタとページ遷移を実装する必要があります。

1. `HEADLESS=false` にして `npm run start:once` を実行
2. 実際のログイン画面・求人一覧画面のHTML構造を確認
3. `adapters.js` の TODO 部分にセレクタを記述
4. 抽出した求人を `onJob(job)` に渡す（`job` は NormalizedJob 形式）

各サイトのセレクタが分かり次第、ここを埋めることで①②③が本番稼働します。

## 動作の流れ

```
[この外部ワーカー]
  ↓ ①/api/ingest/pending をポーリング（実行待ちの検索条件を取得）
  ↓ ②Playwrightで各サイトにログイン＆スクレイピング
  ↓ ③機械フィルタ + AI採点
  ↓ ④/api/ingest/result へ求人を逐次POST（見つけ次第）
  ↓ ⑤/api/ingest/state へ進捗報告（AI担当の可視化に反映）
[Cloudflare側アプリ] ← フロントがポーリングして結果・進捗を表示
```

## VPSへの移行

手元PCで動作確認できたら、同じコードをVPSに置いて `npm start` を
`pm2` や `systemd` で常駐させれば24時間稼働になります。
