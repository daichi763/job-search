// ============================================================
// 設定の読み込み
//   ・媒体のログイン情報は既存の worker/.env をそのまま使う（二重管理しない）
//   ・hub 固有の設定は hub/.env（任意）で上書きできる
//   ・dotenv は worker/node_modules のものを借りる（hub に依存パッケージを増やさない）
// ============================================================
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const APP_DIR = path.resolve(HUB_DIR, '..')
export const WORKER_DIR = path.join(APP_DIR, 'worker')

// worker/node_modules からパッケージを読み込むための require
export const workerRequire = createRequire(path.join(WORKER_DIR, 'package.json'))

let loaded = false
export function loadEnv() {
  if (loaded) return process.env
  loaded = true
  const dotenv = workerRequire('dotenv')
  const workerEnv = path.join(WORKER_DIR, '.env')
  if (fs.existsSync(workerEnv)) dotenv.config({ path: workerEnv, override: true, quiet: true })
  const hubEnv = path.join(HUB_DIR, '.env')
  if (fs.existsSync(hubEnv)) dotenv.config({ path: hubEnv, override: true, quiet: true })
  return process.env
}

const int = (v, d) => {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : d
}
const num = (v, d) => {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : d
}

// hub の設定値（すべて hub/.env で上書き可）
export function config() {
  const e = loadEnv()
  return {
    dbPath: e.HUB_DB_PATH || path.join(HUB_DIR, 'data', 'jobs_hub.sqlite'),
    appUrl: e.APP_URL || 'http://localhost:3000',
    // 同期してよい時間帯（この時刻を過ぎたら取得を打ち切り、掲載終了の判定はしない）
    deadline: e.HUB_SYNC_DEADLINE || '05:00',
    // 掲載終了の安全装置
    completeRatio: num(e.HUB_COMPLETE_RATIO, 0.98), // 取得数が媒体総数のこの割合未満なら「読み切れていない」
    maxCloseRatio: num(e.HUB_MAX_CLOSE_RATIO, 0.05), // 1回でこの割合を超えて消えたら判定を保留
    closeAfterMisses: int(e.HUB_CLOSE_AFTER_MISSES, 2), // 何回連続で一覧に無ければ掲載終了にするか
    deleteAfterHours: int(e.HUB_DELETE_AFTER_HOURS, 24), // 掲載終了から何時間で物理削除するか
    changeLogDays: int(e.HUB_CHANGE_LOG_DAYS, 90), // 変更履歴の保存日数
    pageDelayMs: int(e.HUB_PAGE_DELAY_MS, 500), // ページ間の待機（媒体への負荷軽減）
    pageRetry: int(e.HUB_PAGE_RETRY, 3),
    maxConsecutiveFail: int(e.HUB_MAX_CONSECUTIVE_FAIL, 5),
    requestTimeoutMs: int(e.HUB_REQUEST_TIMEOUT_MS, 90000), // 1回の通信の上限時間
    recoverWaitMs: int(e.HUB_RECOVER_WAIT_MS, 30000), // 取り直す前に待つ時間
    recoverChunk: int(e.HUB_RECOVER_CHUNK, 25),       // 取り直しで小分けにする件数
    maxUnreadable: int(e.HUB_MAX_UNREADABLE, 0),      // どうしても取れない件数がこれ以下なら「読み切れた」とみなす
    headless: (e.HEADLESS || 'true') === 'true',
    pageSize: {
      hitolink: int(e.HUB_HITOLINK_PAGE_SIZE, 1000),
      kintone: 500,
      jobins: 100,
      circus: int(e.HUB_CIRCUS_PAGE_SIZE, 200),
    },
    circusOrderBy: e.HUB_CIRCUS_ORDER_BY || 'publishStartedAt',
    // バックアップ
    backupDir: e.HUB_BACKUP_DIR || path.join(process.env.HOME || '/tmp', 'backups', 'hub'),
    backupKeep: int(e.HUB_BACKUP_KEEP, 3), // 何世代残すか
  }
}
