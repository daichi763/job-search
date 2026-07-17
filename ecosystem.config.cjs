// PM2 プロセス定義
//  - webapp: Cloudflare Pages(D1 --local) 開発サーバ（ポート3000でAPI/UIを提供）
//  - worker: 外部スクレイピングワーカー（circus等を巡回しAIで採点、webappへ払い出し）
//
// worker は index.js 内で dotenv.config() により worker/.env を読み込むため、
// cwd を worker ディレクトリに固定する必要がある（cwd を誤ると .env が読めず
// APP_URL / OPENAI_* / INGEST_TOKEN 等が未設定になり動かない）。
// __dirname を基準にした絶対パスを使うので、どこから pm2 start しても正しく動く。
const path = require('path')
const WORKER_CWD = path.join(__dirname, 'worker')

module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=webapp-production --local --ip 0.0.0.0 --port 3000',
      cwd: __dirname,
      env: { NODE_ENV: 'development', PORT: 3000 },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
    {
      name: 'worker',
      script: 'index.js',
      cwd: WORKER_CWD,
      // index.js 内 dotenv が worker/.env を読み込む。cwd を worker に固定。
      env: { NODE_ENV: 'production' },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      // クラッシュ時の無限再起動暴走を防ぐ（10秒以内に15回落ちたら停止）
      min_uptime: 10000,
      max_restarts: 15,
      restart_delay: 5000,
    },
  ],
}
