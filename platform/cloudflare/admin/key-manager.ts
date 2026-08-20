/**
 * Worker-optimized API-key storage.
 *
 * Registry is touched only by /admin operations. Translation requests route
 * directly to one Durable Object per key, so unrelated keys never serialize.
 * No raw request logs are stored: each shard stores only three rolling counters.
 */
export interface KeyLimits { daily: number; weekly: number; monthly: number }
export interface KeyUsage { daily: number; weekly: number; monthly: number }
interface KeyMeta { id: string; name: string; prefix: string; token: string; limits: KeyLimits; enabled: boolean; createdAt: string; lastUsedAt?: string }
interface ShardRecord extends KeyMeta { fingerprint: string }
export interface PublicKey extends Omit<KeyMeta, 'token'> { usage: KeyUsage }
interface Env { API_KEY_QUOTAS: DurableObjectNamespace }
const DEFAULT_LIMITS: KeyLimits = { daily: 1000, weekly: 5000, monthly: 15000 }
const ranges = ['daily', 'weekly', 'monthly'] as const

function periods(date = new Date()): Record<keyof KeyUsage, string> {
  const day = date.toISOString().slice(0, 10)
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7))).toISOString().slice(0, 10)
  return { daily: day, weekly: monday, monthly: day.slice(0, 7) }
}
function validLimit(value: unknown, fallback: number) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback }
function limits(value: unknown, fallback = DEFAULT_LIMITS): KeyLimits { const source = (value || {}) as Partial<KeyLimits>; return { daily: validLimit(source.daily, fallback.daily), weekly: validLimit(source.weekly, fallback.weekly), monthly: validLimit(source.monthly, fallback.monthly) } }
function publicKey(key: KeyMeta, usage: KeyUsage): PublicKey { const { token: _token, ...result } = key; return { ...result, usage } }
function quota(env: Env, id: string) { return env.API_KEY_QUOTAS.get(env.API_KEY_QUOTAS.idFromName(id)) }

/** One object per key: strict per-key quota with no cross-key contention. */
export class ApiKeyQuota implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const payload = request.method === 'GET' ? {} : await request.json().catch(() => ({})) as Record<string, unknown>
    if (url.pathname === '/setup' && request.method === 'POST') return this.setup(payload)
    if (url.pathname === '/verify' && request.method === 'POST') return this.verify(String(payload.token || ''))
    if (url.pathname === '/summary' && request.method === 'GET') return this.summary()
    if (url.pathname === '/update' && request.method === 'POST') return this.update(payload)
    if (url.pathname === '/remove' && request.method === 'POST') return this.remove()
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  private async hash(value: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }
  private usageKey(range: keyof KeyUsage, value: string) { return `usage:${range}:${value}` }
  private async get() { return this.state.storage.get<ShardRecord>('key') }
  private async usage(): Promise<KeyUsage> { const period = periods(); const values = await Promise.all(ranges.map(range => this.state.storage.get<number>(this.usageKey(range, period[range])))); return { daily: values[0] || 0, weekly: values[1] || 0, monthly: values[2] || 0 } }
  private async setup(payload: Record<string, unknown>) { if (await this.get()) return Response.json({ error: 'Key already initialized' }, { status: 409 }); const meta = payload.key as KeyMeta | undefined; if (!meta?.id || !meta.token) return Response.json({ error: 'Invalid key setup' }, { status: 400 }); const record: ShardRecord = { ...meta, fingerprint: await this.hash(meta.token) }; await this.state.storage.put('key', record); return Response.json({ ok: true }) }
  private async summary() { const key = await this.get(); if (!key) return Response.json({ error: 'Key not found' }, { status: 404 }); return Response.json({ key: publicKey(key, await this.usage()) }) }
  private async update(payload: Record<string, unknown>) { const key = await this.get(); if (!key) return Response.json({ error: 'Key not found' }, { status: 404 }); const next: ShardRecord = { ...key, name: payload.name === undefined ? key.name : String(payload.name).trim().slice(0, 80), enabled: payload.enabled === undefined ? key.enabled : Boolean(payload.enabled), limits: payload.limits === undefined ? key.limits : limits(payload.limits, key.limits) }; await this.state.storage.put('key', next); return Response.json({ key: publicKey(next, await this.usage()) }) }
  private async remove() { await this.state.storage.deleteAll(); return Response.json({ ok: true }) }
  private async verify(token: string) {
    const key = await this.get(); if (!key || !token || !key.enabled || await this.hash(token) !== key.fingerprint) return Response.json({ error: 'Invalid API key' }, { status: 401 })
    const current = await this.usage(); for (const range of ranges) if (key.limits[range] > 0 && current[range] >= key.limits[range]) return Response.json({ error: `${range} quota exhausted` }, { status: 429 })
    const period = periods(); const next = { daily: current.daily + 1, weekly: current.weekly + 1, monthly: current.monthly + 1 }; await this.state.storage.put({ key: { ...key, lastUsedAt: new Date().toISOString() }, [this.usageKey('daily', period.daily)]: next.daily, [this.usageKey('weekly', period.weekly)]: next.weekly, [this.usageKey('monthly', period.monthly)]: next.monthly }); return Response.json({ ok: true })
  }
}

/** Admin-only index. It is deliberately absent from the translation hot path. */
export class ApiKeyRegistry implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url); const payload = request.method === 'GET' || request.method === 'DELETE' ? {} : await request.json().catch(() => ({})) as Record<string, unknown>
    if (url.pathname === '/keys' && request.method === 'GET') return Response.json({ keys: await this.list() })
    if (url.pathname === '/keys/export' && request.method === 'GET') return this.exportCsv()
    if (url.pathname === '/keys/bulk-delete' && request.method === 'POST') return this.bulkDelete(payload)
    if (url.pathname === '/keys' && request.method === 'POST') return this.create(payload)
    const id = url.pathname.match(/^\/keys\/([a-f0-9]{32})$/)?.[1]
    if (id && request.method === 'PATCH') return this.update(id, payload)
    if (id && request.method === 'DELETE') return this.remove(id)
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  private async meta() { return this.state.storage.list<KeyMeta>({ prefix: 'key:' }) }
  private async list(): Promise<PublicKey[]> { const all = await this.meta(); return Promise.all(Array.from(all.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(async key => { const response = await quota(this.env, key.id).fetch('https://quota.internal/summary'); const data = await response.json() as { key?: PublicKey }; return data.key || publicKey(key, { daily: 0, weekly: 0, monthly: 0 }) })) }
  private async create(payload: Record<string, unknown>) { const count = Math.min(100, Math.max(1, Math.floor(Number(payload.count) || 1))); const baseName = String(payload.name || 'API Key').trim().slice(0, 80) || 'API Key'; const keyLimits = limits(payload.limits); const created: Array<PublicKey & { token: string }> = []; for (let index = 0; index < count; index++) { const id = crypto.randomUUID().replaceAll('-', ''); const token = `axl_${id}_${crypto.randomUUID().replaceAll('-', '')}`; const key: KeyMeta = { id, name: count === 1 ? baseName : `${baseName} ${index + 1}`, prefix: token.slice(0, 12), token, limits: keyLimits, enabled: true, createdAt: new Date().toISOString() }; const response = await quota(this.env, id).fetch('https://quota.internal/setup', { method: 'POST', body: JSON.stringify({ key }) }); if (!response.ok) return Response.json({ error: 'Failed to initialize API key' }, { status: 500 }); await this.state.storage.put(`key:${id}`, key); created.push({ ...publicKey(key, { daily: 0, weekly: 0, monthly: 0 }), token }) } return Response.json({ keys: created }, { status: 201 }) }
  private async update(id: string, payload: Record<string, unknown>) { const current = await this.state.storage.get<KeyMeta>(`key:${id}`); if (!current) return Response.json({ error: 'Key not found' }, { status: 404 }); const next: KeyMeta = { ...current, name: payload.name === undefined ? current.name : String(payload.name).trim().slice(0, 80), enabled: payload.enabled === undefined ? current.enabled : Boolean(payload.enabled), limits: payload.limits === undefined ? current.limits : limits(payload.limits, current.limits) }; const response = await quota(this.env, id).fetch('https://quota.internal/update', { method: 'POST', body: JSON.stringify(payload) }); if (!response.ok) return new Response(response.body, { status: response.status }); await this.state.storage.put(`key:${id}`, next); return response }
  private async remove(id: string) { if (!await this.state.storage.get(`key:${id}`)) return Response.json({ error: 'Key not found' }, { status: 404 }); await quota(this.env, id).fetch('https://quota.internal/remove', { method: 'POST' }); await this.state.storage.delete(`key:${id}`); return new Response(null, { status: 204 }) }
  private async bulkDelete(payload: Record<string, unknown>) { const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)))].slice(0, 100) : []; if (!ids.length) return Response.json({ error: 'Select at least one API key' }, { status: 400 }); await Promise.all(ids.map(async id => { await quota(this.env, id).fetch('https://quota.internal/remove', { method: 'POST' }); await this.state.storage.delete(`key:${id}`) })); return Response.json({ deleted: ids.length }) }
  private async exportCsv() { const records = await this.meta(); const rows = await Promise.all(Array.from(records.values()).map(async key => { const response = await quota(this.env, key.id).fetch('https://quota.internal/summary'); const data = await response.json() as { key?: PublicKey }; const usage = data.key?.usage || { daily: 0, weekly: 0, monthly: 0 }; return [key.id, key.name, key.token, key.prefix, key.enabled, key.limits.daily, key.limits.weekly, key.limits.monthly, usage.daily, usage.weekly, usage.monthly, key.createdAt, key.lastUsedAt].map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',') })); const csv = `\uFEFFid,name,api_key,key_prefix,enabled,daily_limit,weekly_limit,monthly_limit,daily_usage,weekly_usage,monthly_usage,created_at,last_used_at\n${rows.join('\n')}\n`; return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="deeplx-api-keys-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' } }) }
}
