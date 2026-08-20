/**
 * DeepLX Serverless - Cloudflare Workers Optimized Entry
 * Inlined: deeplx-lib (translate, parse2DeepLX, getBody) + body-data (bodyData, toWebRequest)
 * Features: Smart Placement, Dual-layer Cache, Token Pre-parsing, Zero Dependencies
 */

// ===== Types =====
interface IEnv {
  token: string;
}

interface DeepLXOptions {
  from: string;
  to: string;
  text: string;
}

interface DeepLResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    texts: Array<{ text: string; alternatives: Array<{ text: string }> }>;
    lang: string;
    lang_is_confident: boolean;
    detectedLanguages: Record<string, number>;
  };
  error?: { code: number; message: string; data: { what: string } };
}

interface DeepLXResponse {
  code: number;
  id: number;
  method: 'Free';
  from: string;
  to: string;
  source_lang: string;
  target_lang: string;
  data: string;
  alternatives: string[];
}

interface ErrorResponse {
  code: number;
  msg: string;
}

// ===== Constants =====
const DEEPL_URL = 'https://www2.deepl.com/jsonrpc';
const CACHE_TTL = 86400; // 24 hours
const MAX_MEMORY_CACHE = 1000;

// Pre-built static headers (zero allocation on hot path)
const CORS_HEADERS = new Headers({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
});

const JSON_HEADERS = new Headers({
  'Content-Type': 'application/json; charset=utf-8',
});

// ===== Global State (persists across requests in same isolate) =====
// Token set - parsed once at module load
const TOKENS_SET = new Set<string>();

// In-memory translation cache (L1 - fastest, per isolate)
const memoryCache = new Map<string, DeepLXResponse>();

// Simple hash for cache keys (fast, good enough for cache keys)
function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// ===== Token Initialization (runs once per isolate) =====
function initTokens(tokenEnv: string): void {
  TOKENS_SET.clear();
  if (tokenEnv) {
    for (const t of tokenEnv.split(',')) {
      const trimmed = t.trim();
      if (trimmed) TOKENS_SET.add(trimmed);
    }
  }
}

// ===== Fast Auth Check =====
function checkAuth(request: Request): boolean {
  if (TOKENS_SET.size === 0) return true; // No token configured = open access
  
  const auth = request.headers.get('Authorization')?.replace('Bearer ', '').trim();
  if (auth && TOKENS_SET.has(auth)) return true;
  
  const urlToken = new URL(request.url).searchParams.get('token');
  return urlToken !== null && TOKENS_SET.has(urlToken);
}

// ===== Request Body Parsing (inlined from body-data, minimal) =====
interface ParsedBody {
  from?: string;
  to?: string;
  text?: string;
  source_lang?: string;
  target_lang?: string;
  [key: string]: unknown;
}

async function parseBody(request: Request): Promise<{ params: Record<string, string>; body: ParsedBody }> {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { params[k] = v; });

  if (request.method === 'GET' || request.method === 'HEAD') {
    return { params, body: {} };
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    const text = await request.text();
    if (!text) return { params, body: {} };

    if (contentType.includes('application/json')) {
      return { params, body: JSON.parse(text) as ParsedBody };
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body: ParsedBody = {};
      new URLSearchParams(text).forEach((v, k) => { body[k] = v; });
      return { params, body };
    }
    return { params, body: { text } };
  } catch {
    return { params, body: {} };
  }
}

// ===== DeepL Request Body Construction (inlined from deeplx-lib) =====
function buildDeepLBody(options: DeepLXOptions): string {
  const { from, to, text } = options;
  
  // getRandomNumber
  const random = (Math.floor(Math.random() * 99999) + 100000) * 1000;
  
  // getICount
  let iCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 105) iCount++; // 'i' char code
  }
  
  // getTimestamp
  const ts = Date.now();
  const timestamp = iCount !== 0 ? ts - (ts % (iCount + 1)) + (iCount + 1) : ts;
  
  const bodyObj = {
    jsonrpc: '2.0',
    method: 'LMT_handle_texts',
    params: {
      splitting: 'newlines',
      lang: {
        source_lang_user_selected: from,
        target_lang: to,
      },
      texts: [{ text, requestAlternatives: 3 }],
      timestamp,
    },
    id: random,
  };
  
  let bodyString = JSON.stringify(bodyObj);
  
  // handlerBodyMethod - modify method field to emulate client
  const calc = (random + 5) % 29 === 0 || (random + 3) % 13 === 0;
  const methodStr = calc ? '"method" : "' : '"method": "';
  bodyString = bodyString.replace('"method":"', methodStr);
  
  return bodyString;
}

// ===== Response Transformation (inlined & optimized parse2DeepLX) =====
function transformResponse(options: DeepLXOptions, data: DeepLResponse): DeepLXResponse {
  const result = data.result!;
  const firstText = result.texts[0] ?? { text: '', alternatives: [] };
  
  return {
    code: 200,
    id: data.id,
    method: 'Free',
    from: options.from,
    to: options.to,
    source_lang: result.lang,
    target_lang: options.to,
    data: firstText.text,
    alternatives: firstText.alternatives.map(a => a.text),
  };
}

// ===== Cache Key Generation =====
function makeCacheKey(from: string, to: string, text: string): string {
  return `tl:${from}:${to}:${hashText(text)}`;
}

// ===== Core Translation with Dual-Layer Cache =====
async function translateWithCache(
  options: DeepLXOptions,
  cache: Cache,
  ctx: ExecutionContext
): Promise<DeepLXResponse> {
  const { from, to, text } = options;
  const cacheKey = makeCacheKey(from, to, text);
  const cacheUrl = `/translate/${cacheKey}`;

  // L1: Memory cache (instant, same isolate)
  const memCached = memoryCache.get(cacheKey);
  if (memCached) return memCached;

  // L2: Edge Cache API (cross-isolate, ~1-2ms)
  const edgeCached = await cache.match(cacheUrl);
  if (edgeCached) {
    const data = await edgeCached.json() as DeepLXResponse;
    // Promote to memory cache
    if (memoryCache.size >= MAX_MEMORY_CACHE) {
      const firstKey = memoryCache.keys().next().value;
      if (firstKey) memoryCache.delete(firstKey);
    }
    memoryCache.set(cacheKey, data);
    return data;
  }

  // Cache miss - call DeepL
  const body = buildDeepLBody(options);
  const response = await fetch(DEEPL_URL, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });

  const rawData = await response.json() as DeepLResponse;

  if (rawData.error) {
    // Don't cache errors, return directly
    return {
      code: response.status,
      id: rawData.id,
      method: 'Free',
      from: options.from,
      to: options.to,
      source_lang: options.from,
      target_lang: options.to,
      data: '',
      alternatives: [],
    };
  }

  const transformed = transformResponse(options, rawData);

  // Write to both caches (async, non-blocking)
  const cacheResponse = new Response(JSON.stringify(transformed), {
    headers: { 'Cache-Control': `public, max-age=${CACHE_TTL}` },
  });
  ctx.waitUntil(cache.put(cacheUrl, cacheResponse));

  // Promote to memory cache
  if (memoryCache.size >= MAX_MEMORY_CACHE) {
    const firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(cacheKey, transformed);

  return transformed;
}

// ===== Main Handler =====
export default {
  async fetch(request: Request, env: IEnv, ctx: ExecutionContext): Promise<Response> {
    // Initialize tokens from env (runs once per isolate, then cached in TOKENS_SET)
    if (TOKENS_SET.size === 0 && env.token) {
      initTokens(env.token);
    }

    const method = request.method;

    // Ultra-fast short-circuit for preflight/HEAD
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }
    if (method !== 'GET' && method !== 'POST') {
      return new Response(null, { status: 405, headers: CORS_HEADERS });
    }

    // Auth check
    if (!checkAuth(request)) {
      return Response.json(
        { code: 403, msg: 'Request missing authentication information' },
        { status: 403, headers: CORS_HEADERS }
      );
    }

    // Parse request
    const { params, body } = await parseBody(request);

    // Normalize language fields (with proper type handling)
    const fromRaw = body.from ?? body.source_lang ?? params.from ?? 'AUTO';
    const toRaw = body.to ?? body.target_lang ?? params.to ?? '';
    const textRaw = body.text ?? params.text ?? '';
    
    const from = String(fromRaw).toUpperCase();
    let to = String(toRaw).toUpperCase();
    const text = String(textRaw);

    // Fix unsupported regional variant (e.g., ZH-HANS -> ZH)
    to = to.split('-')[0] ?? to;

    // Validate required fields
    if (!to || !text) {
      return Response.json(
        { code: 400, msg: 'Missing required fields: to, text' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Path check (only /translate supported)
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/translate')) {
      return Response.json(
        { code: 404, msg: 'Not found' },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    // Translate with dual-layer cache
    const cache = caches.default;
    const result = await translateWithCache({ from, to, text }, cache, ctx);

    // Return with CORS headers
    return Response.json(result, { headers: CORS_HEADERS });
  },
} satisfies ExportedHandler<IEnv>;