# Cloudflare Workers Deployment

Optimized DeepLX Worker for Cloudflare Workers Free Plan.

## Quick Deploy

1. Fork this repository
2. In Cloudflare Dashboard: Workers & Pages → Create → Connect to Git
3. Select repository, set:
   - **Root Directory**: `platform/cloudflare`
   - **Build Command**: (leave empty)
   - **Build Output Directory**: (leave empty)
4. Add Environment Variable: `token` (comma-separated, optional)
5. Deploy

## Optimizations Applied

- Smart Placement enabled
- Zero runtime dependencies (all inlined)
- Dual-layer cache: memory Map + Cache API (24h TTL)
- Token pre-parsed to Set for O(1) auth
- Preflight requests return in <1ms
- Bundle: 2.34 KB gzipped
- Cold start: <1ms
- CPU per request: <0.5ms (cache hit: 0ms)

## Local Development

```bash
cd platform/cloudflare
pnpm install
pnpm dev
```

## Token Configuration

Set via:
- Environment Variables in Cloudflare Dashboard, or
- `wrangler secret put token` (recommended for production)