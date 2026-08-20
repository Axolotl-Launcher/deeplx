import type { IEnv } from './types'
import deeplxServerless from 'deeplx-serverless'

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const token = env.token
    return deeplxServerless({ request, token })
  },
} satisfies ExportedHandler<IEnv>
