import type { IncomingMessage } from 'node:http'

export type TMethod = 'GET' | 'POST'

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

export interface ITranslationCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): void
}

export interface IOptions {
  request: IncomingMessage | Request
  token?: string | string[]
  /** Optional platform cache for successful normalized translations. */
  cache?: ITranslationCache
}

export interface IResultData {
  code: number
  msg: string
}
