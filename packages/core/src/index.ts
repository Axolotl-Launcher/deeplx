import type { IDeepLData, IDeepLDataError, IOptions as DeepLXOptions, TSourceLanguage, TTargetLanguage } from 'deeplx-lib'
import type { IBody, IOptions } from './types'
import { toWebRequest } from 'body-data'
import { DEEPL_URL, getBody, parse2DeepLX } from 'deeplx-lib'
import { authToken, parseToken } from './utils'

export * from './types.d'

const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS'])
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}
// Keep invalid or abusive requests from consuming the Worker memory/CPU allowance.
const MAX_BODY_BYTES = 128 * 1024
const MAX_TEXT_LENGTH = 30_000
const UPSTREAM_TIMEOUT_MS = 12_000

export default async function deeplxServerless(options: IOptions): Promise<Response> {
  const request = toWebRequest(options.request)
  const method = request.method.toUpperCase()

  if (!METHODS.has(method)) {
    return withCors(new Response(null, { status: 405 }))
  }
  if (method === 'HEAD' || method === 'OPTIONS') {
    return withCors(new Response(null, { status: 200 }))
  }

  return withCors(await handle({ ...options, request }))
}

export async function handle(options: IOptions): Promise<Response> {
  const request = toWebRequest(options.request)
  const url = new URL(request.url)
  const tokens = parseToken(options.token)
  const authorization = request.headers.get('authorization')
  const auth = authToken({ tokens, authorization, token: url.searchParams.get('token') ?? undefined })

  // Authenticate before reading the request body, which avoids buffering abusive
  // unauthenticated requests in a Worker isolate.
  if (!auth) {
    return json({ code: 403, msg: 'Request missing authentication information' }, 403)
  }

  if (request.method.toUpperCase() !== 'POST' || !url.pathname.startsWith('/translate')) {
    return json({ code: 404, msg: 'Not found' }, 404)
  }

  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ code: 413, msg: 'Request body is too large' }, 413)
  }

  let body: Partial<IBody>
  try {
    // JSON is the documented API format. text() avoids body-data's ArrayBuffer
    // plus TextDecoder intermediate allocation on the Workers hot path.
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ code: 413, msg: 'Request body is too large' }, 413)
    }
    body = rawBody ? JSON.parse(rawBody) as Partial<IBody> : {}
  }
  catch {
    return json({ code: 400, msg: 'Invalid JSON request body' }, 400)
  }

  const text = body.text
  const fromInput = body.source_lang || body.from || 'AUTO'
  const toInput = body.target_lang || body.to
  if (typeof text !== 'string' || !text || typeof fromInput !== 'string' || typeof toInput !== 'string' || !toInput) {
    return json({ code: 400, msg: 'Text, source language, and target language must be strings' }, 400)
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ code: 413, msg: `Text exceeds the ${MAX_TEXT_LENGTH} character limit` }, 413)
  }

  const translateOptions: DeepLXOptions = {
    text,
    from: fromInput.toUpperCase() as TSourceLanguage,
    // DeepL's free endpoint does not accept regional target variants here.
    to: toInput.split('-', 1)[0].toUpperCase() as TTargetLanguage,
  }
  const cacheKey = `${translateOptions.from}\u0000${translateOptions.to}\u0000${text}`
  const cached = await options.cache?.match(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const response = await translateWithTimeout(translateOptions)
    const translateData = await response.json() as IDeepLData & IDeepLDataError
    if (translateData.error) {
      return json({ code: response.status, ...translateData }, response.status)
    }

    const result = json(parse2DeepLX({ ...translateOptions, ...translateData }), response.status)
    if (result.ok) {
      options.cache?.put(cacheKey, result.clone())
    }
    return result
  }
  catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Translation service timed out'
      : error instanceof Error ? error.message : 'Translation service unavailable'
    const code = error instanceof Error && error.message.startsWith('Too many requests') ? 429 : 502
    return json({ code, msg: message }, code)
  }
}

async function translateWithTimeout(options: DeepLXOptions): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const response = await fetch(DEEPL_URL, {
      method: 'POST',
      body: getBody(options),
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 429) {
      throw new Error('Too many requests, your IP has been blocked by DeepL temporarily')
    }
    return response
  }
  finally {
    clearTimeout(timeout)
  }
}

function json(data: unknown, status: number): Response {
  return Response.json(data, { status })
}

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}
