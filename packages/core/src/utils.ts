import type { IOptions } from './types'

export function parseToken(token: IOptions['token'] = ''): string[] {
  if (Array.isArray(token)) {
    return token
  }
  const tokens = token.split(',').filter(Boolean).map(i => i.trim())
  return tokens
}

export function authToken({ tokens, authorization, token }: { tokens: string[], authorization?: string | null, token?: string }): boolean {
  if (!tokens.length) {
    return true
  }

  if (authorization) {
    const bearerToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
    return Boolean(bearerToken && tokens.includes(bearerToken))
  }

  if (token) {
    return tokens.includes(token)
  }

  return false
}
