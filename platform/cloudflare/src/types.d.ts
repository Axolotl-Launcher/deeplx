export type TMethod = 'GET' | 'POST'

export interface IEnv {
  token: string
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
