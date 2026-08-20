import type { ITranslationCache } from '../../../packages/core/src/types'
import type { IEnv } from './types'
import deeplxServerless from '../../../packages/core/src/index'

export { ApiKeyQuota, ApiKeyRegistry } from '../admin/key-manager'

const CACHE_TTL_SECONDS = 86_400
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}
const WORKERS_FREE_DAILY_REQUESTS = 100_000
const ANALYTICS_CACHE_MS = 5 * 60_000
let usageSnapshot: { expiresAt: number; body: WorkerUsage } | undefined

type WorkerUsage = {
  status: 'available' | 'degraded' | 'unavailable'
  label: string
  detail: string
  generatedAt: string
  workers: { used: number | null; limit: number; window: string }
}

export default {
  async fetch(request: Request, env: IEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const hostname = url.hostname
    const isAdminHost = hostname === 'deepladmin.addre.dpdns.org'

    // Admin subdomain: entire host serves dashboard
    if (isAdminHost) {
      return handleDashboard(request, env, url)
    }

    // Public API domain: deepl.addre.dpdns.org
    if (url.pathname === '/favicon.ico') return env.ASSETS.fetch(request)

    // Root path returns a clean diagnostic message
    if (url.pathname === '/' || url.pathname === '') {
      return Response.json({ name: 'DeepLX Serverless', endpoints: { translate: '/translate' } }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // Translation API (require auth)
    if (url.pathname.startsWith('/translate')) {
      if (request.method === 'OPTIONS' || request.method === 'HEAD') {
        return deeplxServerless({ request, token: getTokens(env.token), cache: createTranslationCache(ctx) })
      }
      const managed = await consumeManagedKey(request, env)
      if (!managed.allowed) return withCors(managed.response)
      return deeplxServerless({
        request,
        token: managed.legacy ? getTokens(env.token) : [managed.token],
        cache: createTranslationCache(ctx),
      })
    }

    // Explicit 404 for all other paths - prevents Assets fallback
    return Response.json({ code: 404, msg: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  },
} satisfies ExportedHandler<IEnv>

async function handleDashboard(request: Request, env: IEnv, url: URL): Promise<Response> {
  try {
    if (!adminAuthorized(request, env)) {
      return Response.json({ error: 'Cloudflare Access authentication required' }, { status: 401 })
    }

    // Session state
    if (url.pathname === '/api/session') {
      const email = request.headers.get('Cf-Access-Authenticated-User-Email')
      return Response.json({ identity: { name: email?.split('@')[0] || '管理员', email: email || null }, organization: 'Axolotl-Launcher', logoutUrl: '/cdn-cgi/access/logout', accessProtected: Boolean(email), dataSource: 'production' }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // Cloudflare usage stats
    if (url.pathname === '/api/cloudflare-usage') {
      return Response.json(await cloudflareUsage(env), { headers: { 'Cache-Control': 'private, max-age=300' } })
    }

    // API Key operations
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice('/api'.length) || '/keys'
      const stub = env.API_KEY_REGISTRY.get(env.API_KEY_REGISTRY.idFromName('registry'))
      const upstream = await stub.fetch(new Request(`https://registry.internal${path}`, { method: request.method, headers: request.headers, body: request.method === 'GET' || request.method === 'DELETE' ? undefined : request.body }))
      return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
    }

    // Serve static assets from the ASSETS binding
    // Map / to /dashboard.html
    // Map /styles.css, /app.js to /styles.css, /app.js
    let assetPath = url.pathname === '/' ? '/dashboard.html' : url.pathname

    return env.ASSETS.fetch(new Request(new URL(assetPath, url), request))
  } catch (err) {
    console.error('handleDashboard error:', err)
    return Response.json({ code: 500, msg: 'Internal server error', error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

type ManagedKeyResult = { allowed: true; token: string; legacy: boolean } | { allowed: false; response: Response }

async function consumeManagedKey(request: Request, env: IEnv): Promise<ManagedKeyResult> {
  const token = extractToken(request)
  if (!token) return { allowed: false, response: Response.json({ code: 403, msg: 'Request missing authentication information' }, { status: 403 }) }

  const keyId = token.match(/^axl_([a-f0-9]{32})_/i)?.[1]?.toLowerCase()
  if (keyId) {
    const stub = env.API_KEY_QUOTAS.get(env.API_KEY_QUOTAS.idFromName(keyId))
    const verified = await stub.fetch('https://quota.internal/verify', { method: 'POST', body: JSON.stringify({ token }) })
    if (verified.ok) return { allowed: true, token, legacy: false }
    if (verified.status !== 401) return { allowed: false, response: verified }
  }

  if (getTokens(env.token).includes(token)) return { allowed: true, token, legacy: true }
  return { allowed: false, response: Response.json({ code: 403, msg: 'Invalid API key' }, { status: 403 }) }
}

function extractToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization')
  if (authorization?.match(/^Bearer\s+/i)) return authorization.replace(/^Bearer\s+/i, '').trim() || null
  return new URL(request.url).searchParams.get('token')
}

async function cloudflareUsage(env: IEnv): Promise<WorkerUsage> {
  const now = Date.now()
  if (usageSnapshot && usageSnapshot.expiresAt > now) return usageSnapshot.body
  const base: WorkerUsage = { status: 'unavailable', label: '未配置 Analytics', detail: '配置 CF_ACCOUNT_ID 和仅含 Analytics Read 权限的 CF_API_TOKEN 后显示过去 24 小时的实际 Workers 请求数。', generatedAt: new Date(now).toISOString(), workers: { used: null, limit: WORKERS_FREE_DAILY_REQUESTS, window: '过去 24 小时' } }
  if (!/^[0-9a-f]{32}$/i.test(env.CF_ACCOUNT_ID || '') || !env.CF_API_TOKEN) return cacheUsage(base, now)
  try {
    const end = new Date(now).toISOString()
    const start = new Date(now - 24 * 60 * 60 * 1000).toISOString()
    const query = `{ viewer { accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) { workersInvocationsAdaptive(filter: { datetime_geq: "${start}", datetime_lt: "${end}" }, limit: 1) { sum { requests } } } } }`
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })
    const payload = await response.json() as { data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> } }; errors?: Array<{ message?: string }> }
    const used = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum?.requests
    if (!response.ok || typeof used !== 'number') throw new Error(payload.errors?.[0]?.message || 'Analytics API 返回了无效数据')
    const ratio = used / WORKERS_FREE_DAILY_REQUESTS
    return cacheUsage({ status: ratio >= 0.8 ? 'degraded' : 'available', label: ratio >= 0.8 ? '接近配额' : '额度充足', detail: `Workers ${used.toLocaleString()}/${WORKERS_FREE_DAILY_REQUESTS.toLocaleString()} 请求（过去 24 小时）`, generatedAt: new Date(now).toISOString(), workers: { used, limit: WORKERS_FREE_DAILY_REQUESTS, window: '过去 24 小时' } }, now)
  }
  catch (error) {
    return cacheUsage({ ...base, status: 'degraded', label: '查询失败', detail: `Workers Analytics 查询失败：${error instanceof Error ? error.message : '未知错误'}` }, now)
  }
}

function cacheUsage(body: WorkerUsage, now: number): WorkerUsage {
  usageSnapshot = { body, expiresAt: now + ANALYTICS_CACHE_MS }
  return body
}

function adminAuthorized(request: Request, env: IEnv): boolean {
  if (request.headers.has('Cf-Access-Authenticated-User-Email')) return true
  return Boolean(env.ADMIN_API_SECRET && request.headers.get('X-Admin-Secret') === env.ADMIN_API_SECRET)
}

function getTokens(token = ''): string[] {
  return token.split(',').map(item => item.trim()).filter(Boolean)
}

function createTranslationCache(ctx: ExecutionContext): ITranslationCache {
  return {
    async match(key) {
      const cacheKey = new Request(`https://deeplx-cache.invalid/${await hashKey(key)}`)
      return caches.default.match(cacheKey) ?? undefined
    },
    put(key, response) {
      ctx.waitUntil((async () => {
        const cacheKey = new Request(`https://deeplx-cache.invalid/${await hashKey(key)}`)
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`)
        await caches.default.put(cacheKey, new Response(response.body, { status: response.status, headers }))
      })())
    },
  }
}

async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value)
  return response
}
