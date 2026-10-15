// ============================================================
// ログイン（担当者アカウント）
//   ・パスワードは PBKDF2-SHA256（10万回）でハッシュ化して保存（平文は保存しない）
//   ・ログイン状態は Cookie（HttpOnly）。DB にはトークンのハッシュだけ保存
//   ・同じログインIDで15分に10回失敗したら一時的にロック
//   ・サーバー同士の呼び出し（worker・cron）は X-Ingest-Token で通す
// ============================================================
import type { D1 } from './db'

export const SESSION_COOKIE = 'sid'
export const SESSION_DAYS = 30
const ITER = 100000 // Cloudflare Workers の PBKDF2 は最大10万回
const MAX_FAILS = 10
const FAIL_WINDOW_MIN = 15

export type User = { id: number; login_id: string; name: string; role: 'admin' | 'staff'; active: number }

const enc = new TextEncoder()
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iter, salt, hash] = String(stored || '').split('$')
  if (kind !== 'pbkdf2' || !iter || !salt || !hash) return false
  const got = await pbkdf2(password, unb64(salt), Number(iter))
  const want = unb64(hash)
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]
  return diff === 0
}

async function sha256(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
}

export function normalizeLoginId(s: unknown): string {
  return String(s ?? '').trim().toLowerCase()
}

export function passwordProblem(pw: unknown): string | null {
  const s = String(pw ?? '')
  if (s.length < 8) return 'パスワードは8文字以上にしてください'
  if (s.length > 200) return 'パスワードが長すぎます'
  return null
}

// ---- ログイン・ログアウト ----
export async function login(db: D1, loginId: string, password: string, ip: string | null):
  Promise<{ ok: true; token: string; user: User } | { ok: false; error: string; locked?: boolean }> {
  const id = normalizeLoginId(loginId)
  if (!id || !password) return { ok: false, error: 'メールアドレスとパスワードを入力してください' }
  const fails: any = await db.prepare(
    `SELECT COUNT(*) AS n FROM login_failures WHERE login_id=? AND created_at > datetime('now', ?)`
  ).bind(id, `-${FAIL_WINDOW_MIN} minutes`).first()
  if ((fails?.n || 0) >= MAX_FAILS) {
    return { ok: false, locked: true, error: `ログインに続けて失敗したため、一時的にロックしています。${FAIL_WINDOW_MIN}分ほど待ってから再度お試しください` }
  }
  const row: any = await db.prepare(`SELECT * FROM users WHERE login_id=?`).bind(id).first()
  const good = row && row.active && (await verifyPassword(password, row.password_hash))
  if (!good) {
    await db.prepare(`INSERT INTO login_failures (login_id, ip) VALUES (?, ?)`).bind(id, ip).run()
    await db.prepare(`DELETE FROM login_failures WHERE created_at < datetime('now', '-1 day')`).run()
    return { ok: false, error: row && !row.active ? 'このアカウントは無効になっています。管理者にお問い合わせください' : 'メールアドレスまたはパスワードが違います' }
  }
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  await db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(await sha256(token), row.id, `+${SESSION_DAYS} days`).run()
  await db.prepare(`UPDATE users SET last_login_at=datetime('now') WHERE id=?`).bind(row.id).run()
  await db.prepare(`DELETE FROM login_failures WHERE login_id=?`).bind(id).run()
  await db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run()
  return { ok: true, token, user: publicUser(row) }
}

export async function userFromToken(db: D1, token: string | undefined): Promise<User | null> {
  if (!token) return null
  const row: any = await db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash=? AND s.expires_at > datetime('now') AND u.active=1`
  ).bind(await sha256(token)).first()
  return row ? publicUser(row) : null
}

export async function logout(db: D1, token: string | undefined): Promise<void> {
  if (token) await db.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(await sha256(token)).run()
}

export function publicUser(r: any): User {
  return { id: r.id, login_id: r.login_id, name: r.name, role: r.role === 'admin' ? 'admin' : 'staff', active: r.active ? 1 : 0 }
}

// ---- 担当者の管理（管理者のみ） ----
export async function listUsers(db: D1) {
  const { results } = await db.prepare(
    `SELECT id, login_id, name, role, active, created_at, last_login_at FROM users ORDER BY active DESC, role='admin' DESC, id`
  ).all()
  return results || []
}

async function activeAdminCount(db: D1, exceptId?: number): Promise<number> {
  const r: any = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id != ?`).bind(exceptId ?? -1).first()
  return r?.n || 0
}

export async function createUser(db: D1, body: any): Promise<{ ok: boolean; error?: string; id?: number }> {
  const loginId = normalizeLoginId(body.login_id)
  const name = String(body.name ?? '').trim()
  const role = body.role === 'admin' ? 'admin' : 'staff'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId)) return { ok: false, error: 'メールアドレスの形式が正しくありません' }
  if (!name) return { ok: false, error: '名前を入力してください' }
  const pw = passwordProblem(body.password)
  if (pw) return { ok: false, error: pw }
  const exists = await db.prepare(`SELECT id FROM users WHERE login_id=?`).bind(loginId).first()
  if (exists) return { ok: false, error: 'このメールアドレスはすでに登録されています' }
  const r = await db.prepare(`INSERT INTO users (login_id, name, password_hash, role) VALUES (?, ?, ?, ?)`)
    .bind(loginId, name.slice(0, 50), await hashPassword(String(body.password)), role).run()
  return { ok: true, id: Number(r.meta?.last_row_id) }
}

export async function updateUser(db: D1, id: number, body: any, me: User): Promise<{ ok: boolean; error?: string }> {
  const row: any = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first()
  if (!row) return { ok: false, error: '担当者が見つかりません' }
  const sets: string[] = [], vals: any[] = []
  if (body.name != null) {
    const name = String(body.name).trim()
    if (!name) return { ok: false, error: '名前を入力してください' }
    sets.push('name=?'); vals.push(name.slice(0, 50))
  }
  if (body.login_id != null) {
    const loginId = normalizeLoginId(body.login_id)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId)) return { ok: false, error: 'メールアドレスの形式が正しくありません' }
    const dup = await db.prepare(`SELECT id FROM users WHERE login_id=? AND id != ?`).bind(loginId, id).first()
    if (dup) return { ok: false, error: 'このメールアドレスはすでに登録されています' }
    sets.push('login_id=?'); vals.push(loginId)
  }
  const demote = (body.role != null && body.role !== 'admin' && row.role === 'admin') || (body.active != null && !body.active && row.active && row.role === 'admin')
  if (demote && (await activeAdminCount(db, id)) === 0) return { ok: false, error: '管理者が1人もいなくなるため変更できません（先に別の担当者を管理者にしてください）' }
  if (body.active != null && !body.active && id === me.id) return { ok: false, error: '自分自身は無効にできません' }
  if (body.role != null) { sets.push('role=?'); vals.push(body.role === 'admin' ? 'admin' : 'staff') }
  if (body.active != null) { sets.push('active=?'); vals.push(body.active ? 1 : 0) }
  if (body.password) {
    const pw = passwordProblem(body.password)
    if (pw) return { ok: false, error: pw }
    sets.push('password_hash=?'); vals.push(await hashPassword(String(body.password)))
  }
  if (!sets.length) return { ok: true }
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).bind(...vals, id).run()
  // 無効化・パスワード変更のときは、その担当者のログイン状態を解除する
  if ((body.active != null && !body.active) || (body.password && id !== me.id)) await db.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run()
  return { ok: true }
}

export async function deleteUser(db: D1, id: number, me: User): Promise<{ ok: boolean; error?: string }> {
  if (id === me.id) return { ok: false, error: '自分自身は削除できません' }
  const row: any = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first()
  if (!row) return { ok: false, error: '担当者が見つかりません' }
  if (row.role === 'admin' && row.active && (await activeAdminCount(db, id)) === 0) return { ok: false, error: '最後の管理者は削除できません' }
  await db.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run()
  await db.prepare(`DELETE FROM users WHERE id=?`).bind(id).run()
  return { ok: true }
}

export async function changeOwnPassword(db: D1, me: User, current: string, next: string): Promise<{ ok: boolean; error?: string }> {
  const row: any = await db.prepare(`SELECT password_hash FROM users WHERE id=?`).bind(me.id).first()
  if (!row || !(await verifyPassword(String(current || ''), row.password_hash))) return { ok: false, error: '現在のパスワードが違います' }
  const pw = passwordProblem(next)
  if (pw) return { ok: false, error: pw }
  await db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).bind(await hashPassword(next), me.id).run()
  return { ok: true }
}
