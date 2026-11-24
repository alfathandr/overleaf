import getMeta from '@/utils/meta'

export type AiProviderId = 'anthropic' | 'gemini' | 'openai' | 'custom'

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

export type ChatTurnResponse = {
  reply: string
  proposedEdits: ProposedEdit[]
  previewPages: PreviewPage[]
  toolTrace: ToolTraceItem[]
}

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

  createMcpToken: (name: string) =>
    requestJson<{ token: McpTokenItem }>('/api/ai/mcp/tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  revokeMcpToken: (tokenId: string) =>
    requestJson<{ ok: boolean }>(`/api/ai/mcp/tokens/${tokenId}`, {
      method: 'DELETE',
    }),

  chat: (
    projectId: string,
    payload: {
      message: string
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      activeDocPath?: string | null
      images?: ChatImageInput[]
      autoApply?: boolean
      autoPreview?: boolean
    }
  ) =>
    requestJson<ChatTurnResponse>(`/api/ai/project/${projectId}/chat`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

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
