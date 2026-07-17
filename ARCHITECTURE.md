# デプロイ構成（重要・誤認注意）

> ⚠️ **このアプリは 100% さくらVPS 上で動いています。Cloudflare は一切使っていません。**
> `wrangler pages dev` を使っているのは「ローカル実行ツール」としてであり、
> Cloudflare Pages にデプロイしているわけではありません。何度も「Cloudflare」と
> 誤認しがちなので、作業前に必ずこの文書を読むこと。

## 実行環境
- **サーバー**: さくらVPS（有料プラン）`133.167.66.111`
- **公開URL**: `http://133.167.66.111:3000`
- **プロジェクトパス（VPS）**: `/home/ubuntu/webapp`
- **プロジェクトパス（sandbox）**: `/home/user/webapp`
- **GitHub**: github.com/daichi763/job-search（branch: main）
- **Cloudflare**: ❌ **未使用**（Pages/Workers/D1クラウド/KV/R2 いずれも使っていない）

## プロセス構成（PM2、すべてVPS上のNodeプロセス）
| PM2 id | name | 実体 | 役割 |
|--------|------|------|------|
| 0 | `webapp` | `wrangler pages dev dist --d1=webapp-production --local --port 3000` | フロント＋API（Hono）。`--local` なので **D1はローカルSQLite**（`.wrangler/state/v3/d1`）。クラウドのD1ではない |
| 1 | `worker` | `node index.js`（cwd=`worker/`） | circus等をPlaywrightでスクレイピングし ingest API 経由で払い出す外部ワーカー |

- 両者は `APP_URL=http://localhost:3000` で連携。
- `wrangler pages dev` は **単にHonoアプリをローカルで動かすためのランナー**。デプロイ先はVPSであってCloudflareではない。

## 環境変数の置き場所（混同注意）
kintone のような **webapp側で処理する機能** と、circus のような **worker側で処理する機能** で
設定ファイルが違う。ここを間違えると「設定したのに効かない」となる。

| 機能 | 処理する場所 | 設定ファイル |
|------|------------|------------|
| **kintone（自社DB）** | **webapp側**（`src/lib/kintone.ts` + `orchestrator.ts`。Hono内で完結） | **`/home/ubuntu/webapp/.dev.vars`** |
| OpenAI採点（webapp内） | webapp側 | `/home/ubuntu/webapp/.dev.vars` |
| circus / hitolink / jobins | **worker側**（Playwright） | `/home/ubuntu/webapp/worker/.env` |
| OpenAI（検索プラン設計・PDF解析） | worker側 | `/home/ubuntu/webapp/worker/.env` |

### ポイント
- **kintone は外部ワーカー経由ではなく webapp（Hono）側で直接 REST API を叩く**。
  → よって kintone の設定先は `worker/.env` ではなく **webapp の `.dev.vars`**。
- `worker/.env` の `SOURCES` は **`circus,hitolink`**（worker側で処理するもののみ）。
  kintone はwebapp側が担当するため **SOURCES に入れない**（入れると二重処理になりうる）。
- hitolink は Azure AD B2C(OAuth2)でログイン → `SESSION` Cookie で内部API(Next.js Server Action)を叩く。
  認証情報は `HITOLINK_LOGIN_URL`(=`/login`) / `HITOLINK_ID` / `HITOLINK_PW`（`worker/.env`）。

## 反映手順（VPS）
```bash
cd /home/ubuntu/webapp
git pull origin main
npm run build          # コード変更を反映
pm2 restart webapp     # .dev.vars / src の変更
pm2 restart worker     # worker/.env / worker/ の変更
pm2 save               # 再起動後も残す
```

## 誤認防止チェックリスト
- [ ] 「Cloudflareにデプロイ」と言いかけていないか → **違う。VPSで動いている**
- [ ] kintoneの設定を `worker/.env` に書いていないか → **`.dev.vars` が正しい**
- [ ] D1を「クラウドのD1」と思っていないか → **`--local` のローカルSQLite**
- [ ] `wrangler pages dev` を「Cloudflareへの公開」と思っていないか → **ローカルランナー**
</content>
</invoke>
