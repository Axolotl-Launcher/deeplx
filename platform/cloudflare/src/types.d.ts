export type TMethod = 'GET' | 'POST'

export interface IEnv {
  /** Legacy static comma-separated tokens; retained only for backwards compatibility. */
  token?: string
  /** Admin-only key registry; not used by translation requests. */
  API_KEY_REGISTRY: DurableObjectNamespace
  /** One Durable Object per API key for strict sharded quota enforcement. */
  API_KEY_QUOTAS: DurableObjectNamespace
  /** Static assets for the Access-protected management console. */
  ASSETS: Fetcher
  /** Local development fallback; production admin access must use Cloudflare Access. */
  ADMIN_API_SECRET?: string
  /** Optional Cloudflare GraphQL Analytics credentials; always stay server-side. */
  CF_ACCOUNT_ID?: string
  CF_API_TOKEN?: string
}

export interface IParams {
  token: string
}

export interface IBody {
  from: string
  to: string
  text: string
  source_lang: string
  target_lang: string
}
