# DeepLX Serverless

A free-to-deploy translation API, compatible with OwO-Network/DeepLX, built with serverless platforms to avoid frequent request issues such as HTTP 429 Too Many Requests.

> **Note:** For better security and to prevent misuse, it is strongly recommended to configure a `token`. Multiple tokens can be set using commas (`,`).

## Deployment

Click the one-click deploy buttons below, or fork the repository and configure the deployment manually.

### Vercel

* **One-Click Deploy:**

  [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flete114%2Fdeeplx-serverless%2Ftree%2Fmain%2Fplatform%2Fvercel&env=token&envDescription=Configure%20the%20token%20to%20be%20more%20secure%20and%20avoid%20misuse%20by%20others.%20Multiple%20tokens%20are%20separated%20by%20commas&project-name=deeplx&repository-name=deeplx-serverless)

* **Manual Deploy:**

  1. Create a new project in Vercel (or import your forked repository)
  2. Go to the project → `Settings` → `Build and Development`
  3. Set `Root Directory` to: `platform/vercel`
  4. Go to `Environment Variables` Add an environment variable: `token` (Optional)

### Netlify

* **One-Click Deploy:**

  [![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https%3A%2F%2Fgithub.com%2Flete114%2Fdeeplx-serverless&create_from_path=platform/netlify)

* **Manual Deploy:**

  1. Fork this repository and import it into Netlify
  2. Go to Site Settings `Project configuration` → `Build & Deploy` → `Build settings`
  3. Set `Package directory` to: `platform/netlify`
  4. Go to `Environment Variables` Add an environment variable: `token` (Optional)

### Cloudflare Workers (Optimized)

* **One-Click Deploy:**

  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Flete114%2Fdeeplx-serverless%2Ftree%2Fmain%2Fplatform%2Fcloudflare)

* **Manual Deploy:**

  1. Fork this repository and import it into Cloudflare Workers
  2. Set `Root Directory` to: `platform/cloudflare`
  3. Go to `Settings` → `Variables` → Add `token` (Optional, or use Secrets)
  4. Deploy

#### Cloudflare Workers Optimizations

This deployment includes the following performance optimizations:

- **Smart Placement** enabled - automatically routes Workers to data centers closest to DeepL API
- **Zero dependencies** - all core logic inlined into a single Worker file (no npm packages at runtime)
- **Dual-layer caching** - in-memory Map (L1) + Cloudflare Cache API (L2, 24h TTL) for instant cache hits
- **Token pre-parsing** - tokens parsed once at module load into a Set for O(1) auth checks
- **Ultra-fast preflight** - OPTIONS/HEAD requests return immediately with pre-built CORS headers
- **Minimal bundle** - 2.34 KB gzipped, cold start under 1ms
- **CPU optimized** - typical request under 0.5ms CPU time, cache hits use 0 CPU and 0 subrequests

## Usage

### Request Example

```bash
curl 'https://your-api-address/translate?token=your-token' \
--header 'Content-Type: application/json' \
--data '{
  "text": "Hello, World",
  "from": "en",
  "to": "zh"
}'

# Or use Authorization header
curl 'https://your-api-address/translate' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer your-token' \
--data '{
  "text": "Hello, World",
  "from": "en",
  "to": "zh"
}'
```

### Response Example

```json
{
  "code": 200,
  "id": 145289000,
  "method": "Free",
  "from": "EN",
  "to": "ZH",
  "source_lang": "EN",
  "target_lang": "ZH",
  "data": "你好，世界",
  "alternatives": [
    "世界，你好",
    "世界你好",
    "您好，世界"
  ]
}
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `token` | No | Comma-separated list of valid tokens. If not set, the API is open. |

### Supported Languages

All DeepL supported languages. Regional variants (e.g., `zh-HANS`, `en-GB`) are normalized to base language codes.

### API Endpoint

```
POST /translate
GET  /translate?text=...&to=...&from=...
```

Request body (JSON):
```json
{
  "text": "text to translate",
  "to": "target language code",
  "from": "source language code (optional, default: AUTO)",
  "source_lang": "alias for from",
  "target_lang": "alias for to"
}
```

## Performance Notes (Cloudflare Free Plan)

- **Daily requests:** 100,000
- **Per minute:** 1,000
- **CPU time per request:** 10ms
- **Subrequests per request:** 50

With caching enabled, typical workloads can serve 5x+ more requests within free limits.

## License

MIT License - see LICENSE file for details.