import getMeta from '@/utils/meta'

export type AiProviderId = 'anthropic' | 'gemini' | 'openai' | 'custom'
export type McpTokenScope = 'read' | 'write'

export type AiConfig = {
  provider: AiProviderId
  model: string
  baseUrl: string
  autoApply: boolean
  autoPreview: boolean
  maxPreviewPages: number
  apiKeys: Record<AiProviderId, { configured: boolean; masked: string }>
}

export type AiSkillItem = {
  id: string
  name: string
  slug: string
  description: string
  instructions: string
  enabled: boolean
  source: 'manual' | 'upload' | 'url' | 'builtin'
  sourceUrl?: string
}

export type McpTokenItem = {
  id: string
  name: string
  scope: McpTokenScope
  tokenPrefix: string
  createdAt: string
  lastUsedAt: string | null
  rawToken?: string
}

export type ProposedEdit = {
  id: string
  type: 'edit' | 'create'
  path: string
  summary: string
  oldContent: string
  newContent: string
  diff: string
  changedLines: number
  applied: boolean
  reverted?: boolean
  dismissed?: boolean
}

export type PreviewPage = {
  page: number
  mimeType: string
  base64: string
}

export type ToolTraceItem = {
  tool: string
  args: Record<string, unknown>
  preview: string
  imageCount: number
}

export type ChatImageInput = {
  name: string
  mimeType: string
  base64: string
}

export type ChatSessionSummary = {
  id: string
  title: string
  messageCount: number
  updatedAt: string
  createdAt: string
}

export type PersistedChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  proposedEdits?: ProposedEdit[]
  toolTrace?: ToolTraceItem[]
  createdAt?: string
}

export type ChatTurnResponse = {
  reply: string
  proposedEdits: ProposedEdit[]
  previewPages: PreviewPage[]
  toolTrace: ToolTraceItem[]
  sessionId?: string
  sessionTitle?: string
}

export type ChatStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_start'; tool: string; args: Record<string, unknown> }
  | {
      type: 'tool_end'
      tool: string
      args: Record<string, unknown>
      preview: string
      imageCount: number
    }
  | { type: 'proposed_edit'; edit: ProposedEdit }
  | { type: 'preview_page'; page: PreviewPage }
  | ({ type: 'done' } & ChatTurnResponse)
  | { type: 'error'; error: string }

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const csrfToken = getMeta('ol-csrfToken') || ''
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Csrf-Token': csrfToken,
    ...(options.headers as Record<string, string> | undefined),
  }

  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`)
  }
  return data as T
}

export const aiApi = {
  getConfig: () => requestJson<AiConfig>('/api/ai/config'),

  updateConfig: (payload: {
    provider?: AiProviderId
    model?: string
    baseUrl?: string
    apiKey?: string
    apiKeyProvider?: AiProviderId
    clearApiKey?: boolean
    autoApply?: boolean
    autoPreview?: boolean
    maxPreviewPages?: number
  }) =>
    requestJson<AiConfig>('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  testConnection: (payload: {
    provider: AiProviderId
    model: string
    baseUrl?: string
    apiKey?: string
  }) =>
    requestJson<{
      ok: boolean
      latencyMs: number
      provider: string
      model: string
      reply: string
    }>('/api/ai/test-connection', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listSkills: () => requestJson<{ skills: AiSkillItem[] }>('/api/ai/skills'),

  createSkill: (payload: {
    name?: string
    description?: string
    instructions?: string
    markdown?: string
    source?: 'manual' | 'upload'
  }) =>
    requestJson<{ skill: AiSkillItem }>('/api/ai/skills', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  importSkillFromUrl: (url: string) =>
    requestJson<{ skill: AiSkillItem }>('/api/ai/skills/import-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  updateSkill: (
    skillId: string,
    payload: Partial<Pick<AiSkillItem, 'name' | 'description' | 'instructions' | 'enabled'>>
  ) =>
    requestJson<{ skill: AiSkillItem }>(`/api/ai/skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteSkill: (skillId: string) =>
    requestJson<{ ok: boolean }>(`/api/ai/skills/${skillId}`, {
      method: 'DELETE',
    }),

  listMcpTokens: () =>
    requestJson<{ tokens: McpTokenItem[] }>('/api/ai/mcp/tokens'),

  createMcpToken: (name: string, scope: McpTokenScope = 'write') =>
    requestJson<{ token: McpTokenItem }>('/api/ai/mcp/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, scope }),
    }),

  revokeMcpToken: (tokenId: string) =>
    requestJson<{ ok: boolean }>(`/api/ai/mcp/tokens/${tokenId}`, {
      method: 'DELETE',
    }),

  listSessions: (projectId: string) =>
    requestJson<{ sessions: ChatSessionSummary[] }>(
      `/api/ai/project/${projectId}/sessions`
    ),

  getSession: (projectId: string, sessionId: string) =>
    requestJson<{
      session: {
        id: string
        title: string
        messages: PersistedChatMessage[]
        updatedAt: string
      }
    }>(`/api/ai/project/${projectId}/sessions/${sessionId}`),

  createSession: (projectId: string, title = 'New Chat') =>
    requestJson<{
      session: {
        id: string
        title: string
        messages: PersistedChatMessage[]
        updatedAt: string
      }
    }>(`/api/ai/project/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  deleteSession: (projectId: string, sessionId: string) =>
    requestJson<{ ok: boolean }>(
      `/api/ai/project/${projectId}/sessions/${sessionId}`,
      { method: 'DELETE' }
    ),

  chatStream: async (
    projectId: string,
    payload: {
      sessionId?: string | null
      message: string
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      activeDocPath?: string | null
      selectedText?: string | null
      images?: ChatImageInput[]
      autoApply?: boolean
      autoPreview?: boolean
    },
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatTurnResponse> => {
    const csrfToken = getMeta('ol-csrfToken') || ''
    const res = await fetch(`/api/ai/project/${projectId}/chat/stream`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrfToken,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}))
      throw new Error(errData?.error || `Stream failed (${res.status})`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResult: ChatTurnResponse | null = null

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() || ''

      for (const chunk of chunks) {
        const line = chunk
          .split('\n')
          .find(l => l.startsWith('data:'))
        if (!line) continue
        const jsonStr = line.slice(5).trim()
        if (!jsonStr) continue
        const evt = JSON.parse(jsonStr) as ChatStreamEvent
        onEvent(evt)
        if (evt.type === 'error') {
          throw new Error(evt.error)
        }
        if (evt.type === 'done') {
          finalResult = evt
        }
      }
    }

    if (!finalResult) {
      throw new Error('Stream ended unexpectedly without a final response')
    }
    return finalResult
  },

  applyEdit: (projectId: string, path: string, content: string) =>
    requestJson<{ ok: boolean; path: string }>(
      `/api/ai/project/${projectId}/apply`,
      {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      }
    ),

  preview: (projectId: string, maxPages = 2) =>
    requestJson<{
      status: string
      hasPdf: boolean
      errors: string[]
      warnings: string[]
      previewPages: PreviewPage[]
    }>(`/api/ai/project/${projectId}/preview`, {
      method: 'POST',
      body: JSON.stringify({ maxPages }),
    }),
}
