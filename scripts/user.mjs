#!/usr/bin/env node
// ============================================================
// 担当者アカウントをコマンドで作る・パスワードを再設定する（最初の管理者の作成や、管理者がログインできなくなったとき用）
//   普段の追加・変更・無効化は、画面の「担当者の管理」（/admin/users）で行う。
//
//   node scripts/user.mjs add   --email=a@example.com --name="山田 太郎" --admin   # パスワードは聞かれる（画面に表示しない）
//   node scripts/user.mjs reset --email=a@example.com                                # パスワードの再設定
//   node scripts/user.mjs list
//   ※ 本番（VPS）は --local のD1（webapp が使っているもの）に書き込む。--remote を付けると Cloudflare 上のD1へ
// ============================================================
import { execFileSync } from 'node:child_process'
import { webcrypto as crypto } from 'node:crypto'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, ...rest] = process.argv.slice(2)
const opt = Object.fromEntries(rest.map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true] }))
const where = opt.remote ? '--remote' : '--local'

function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'webapp-production', where, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out)[0]?.results || []
}
const jst = (s) => s ? new Date(new Date(String(s).replace(' ', 'T') + 'Z').getTime() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + '（日本時間）' : '—'
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

async function hashPassword(pw) {
  const ITER = 100000
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256))
  return `pbkdf2$${ITER}$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`
}

function askHidden(label) {
  if (opt.password) return Promise.resolve(String(opt.password))
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(label)) process.stdout.write(s) }
    rl.question(label, (a) => { rl.close(); process.stdout.write('\n'); resolve(a) })
  })
}
async function askPassword() {
  const a = await askHidden('パスワード（8文字以上）: ')
  if (a.length < 8) throw new Error('パスワードは8文字以上にしてください')
  if (!opt.password) { const b = await askHidden('もう一度: '); if (a !== b) throw new Error('パスワードが一致しません') }
  return a
}

async function main() {
  const email = String(opt.email || '').trim().toLowerCase()
  if (cmd === 'list') {
    for (const u of d1('SELECT id, login_id, name, role, active, last_login_at FROM users ORDER BY id')) console.log(`${u.id}\t${u.role === 'admin' ? '管理者' : '担当者'}\t${u.active ? '有効' : '無効'}\t${u.name}\t${u.login_id}\t最終ログイン ${jst(u.last_login_at)}`)
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email=メールアドレス を指定してください')
  if (cmd === 'add') {
    const name = String(opt.name || '').trim()
    if (!name) throw new Error('--name="名前" を指定してください')
    if (d1(`SELECT id FROM users WHERE login_id=${q(email)}`).length) throw new Error(`${email} はすでに登録されています（パスワードを変える場合は reset）`)
    const hash = await hashPassword(await askPassword())
    d1(`INSERT INTO users (login_id, name, password_hash, role) VALUES (${q(email)}, ${q(name)}, ${q(hash)}, ${q(opt.admin ? 'admin' : 'staff')})`)
    console.log(`作成しました: ${name}（${email}・${opt.admin ? '管理者' : '担当者'}）`)
  } else if (cmd === 'reset') {
    if (!d1(`SELECT id FROM users WHERE login_id=${q(email)}`).length) throw new Error(`${email} は登録されていません`)
    const hash = await hashPassword(await askPassword())
    d1(`UPDATE users SET password_hash=${q(hash)}, active=1 WHERE login_id=${q(email)}`)
    d1(`DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE login_id=${q(email)})`)
    d1(`DELETE FROM login_failures WHERE login_id=${q(email)}`)
    console.log(`パスワードを再設定しました: ${email}（ロックも解除）`)
  } else {
    console.log('使い方: node scripts/user.mjs add --email=... --name="..." [--admin] / reset --email=... / list')
  }
}
main().catch((e) => { console.error('エラー:', e.message); process.exitCode = 1 })
