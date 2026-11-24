import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import {
  aiApi,
  AiConfig,
  AiProviderId,
  AiSkillItem,
  ChatImageInput,
  ChatSessionSummary,
  McpTokenItem,
  McpTokenScope,
  PreviewPage,
  ProposedEdit,
  ToolTraceItem,
} from './api'
import { MarkdownKatex } from './markdown-katex'

type PanelTab = 'chat' | 'skills' | 'mcp' | 'settings'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ChatImageInput[]
  proposedEdits?: ProposedEdit[]
  previewPages?: PreviewPage[]
  toolTrace?: ToolTraceItem[]
  error?: string
}

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  custom: 'Custom (OpenAI-Compatible)',
}

const MODEL_PLACEHOLDERS: Record<AiProviderId, string> = {
  anthropic: 'e.g. claude-sonnet-4-20250514',
  gemini: 'e.g. gemini-2.5-pro',
  openai: 'e.g. gpt-4o',
  custom: 'e.g. anthropic/claude-3.7-sonnet or qwen2.5-vl',
}

function getCurrentOpenDocPath(): string | null {
  try {
    const ide = (window as unknown as Record<string, any>)._ide
    const name = ide?.editorManager?.getCurrentDocName?.()
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}

function captureEditorSelection(): string {
  try {
    const ide = (window as unknown as Record<string, any>)._ide
    const cm =
      ide?.editorManager?.getCodeMirror?.() ||
      ide?.editorManager?.$scope?.editor?.sharejs_doc
    if (cm?.state?.selection?.main) {
      const { from, to } = cm.state.selection.main
      if (to > from) {
        return String(cm.state.doc.sliceString(from, to) || '').trim()
      }
    }
    const sel = window.getSelection?.()?.toString() || ''
    return sel.trim()
  } catch {
    return ''
  }
}

function triggerOverleafPdfRecompile() {
  try {
    const recompileBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="recompile-btn"], .btn-recompile, button[aria-label*="Recompile"]'
    )
    if (recompileBtn && !recompileBtn.disabled) {
      recompileBtn.click()
      return
    }
    window.dispatchEvent(new CustomEvent('ide:compile'))
  } catch {
    // non-fatal
  }
}

export const AiAssistantIcon: React.FC<{ open: boolean; title: string }> = ({
  title,
}) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-label={title}
  >
    <path d="M12 3l1.9 5.8L20 10.7l-5.8 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9L12 3z" />
    <path d="M19 3l.7 2.1L22 5.8l-2.3.7L19 8.6l-.7-2.1L16 5.8l2.3-.7L19 3z" />
  </svg>
)

const ColoredDiff: React.FC<{ diff: string }> = ({ diff }) => {
  const lines = String(diff || '').split(/\r?\n/)
  return (
    <pre
      style={{
        margin: 0,
        padding: '6px 0',
        maxHeight: '180px',
        overflow: 'auto',
        fontSize: '11px',
        background: '#0f172a',
        color: '#cbd5e1',
        lineHeight: 1.45,
      }}
    >
      {lines.map((line, i) => {
        const isAdd = line.startsWith('+ ')
        const isDel = line.startsWith('- ')
        return (
          <div
            key={i}
            style={{
              padding: '0 8px',
              background: isAdd
                ? 'rgba(34, 197, 94, 0.22)'
                : isDel
                  ? 'rgba(239, 68, 68, 0.22)'
                  : 'transparent',
              color: isAdd ? '#86efac' : isDel ? '#fca5a5' : '#cbd5e1',
            }}
          >
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export default function AiAssistantPanel() {
  const { projectId } = useProjectContext()
  const [activeTab, setActiveTab] = useState<PanelTab>('chat')

  // Config state
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [providerDraft, setProviderDraft] = useState<AiProviderId>('openai')
  const [modelDraft, setModelDraft] = useState('')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [autoApply, setAutoApply] = useState(false)
  const [autoPreview, setAutoPreview] = useState(true)
  const [maxPreviewPages, setMaxPreviewPages] = useState(2)
  const [configStatus, setConfigStatus] = useState<string | null>(null)
  const [testingConn, setTestingConn] = useState(false)

  // Persistent Chat Sessions state
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [selectedSnippet, setSelectedSnippet] = useState('')
  const [attachedImages, setAttachedImages] = useState<ChatImageInput[]>([])
  const [sending, setSending] = useState(false)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [liveTools, setLiveTools] = useState<string[]>([])
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Skills state
  const [skills, setSkills] = useState<AiSkillItem[]>([])
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillDesc, setNewSkillDesc] = useState('')
  const [newSkillBody, setNewSkillBody] = useState('')
  const [skillUrl, setSkillUrl] = useState('')
  const [skillStatus, setSkillStatus] = useState<string | null>(null)
  const skillFileRef = useRef<HTMLInputElement>(null)

  // MCP state
  const [mcpTokens, setMcpTokens] = useState<McpTokenItem[]>([])
  const [newTokenName, setNewTokenName] = useState('Claude Desktop / Cursor')
  const [newTokenScope, setNewTokenScope] = useState<McpTokenScope>('write')
  const [freshRawToken, setFreshRawToken] = useState<string | null>(null)
  const [mcpStatus, setMcpStatus] = useState<string | null>(null)

  const mcpEndpointUrl = useMemo(() => {
    if (typeof window === 'undefined') return 'http://localhost:8080/mcp'
    return `${window.location.origin}/mcp`
  }, [])

  const loadSessionMessages = useCallback(
    async (sid: string) => {
      if (!projectId) return
      try {
        const res = await aiApi.getSession(projectId, sid)
        setActiveSessionId(res.session.id)
        setMessages(
          (res.session.messages || []).map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            proposedEdits: m.proposedEdits,
            toolTrace: m.toolTrace,
          }))
        )
      } catch {
        // ignore missing session
      }
    },
    [projectId]
  )

  const loadAll = useCallback(async () => {
    try {
      const [cfg, sk, tk, sessRes] = await Promise.all([
        aiApi.getConfig(),
        aiApi.listSkills(),
        aiApi.listMcpTokens(),
        projectId
          ? aiApi.listSessions(projectId)
          : Promise.resolve({ sessions: [] }),
      ])
      setConfig(cfg)
      setProviderDraft(cfg.provider)
      setModelDraft(cfg.model)
      setBaseUrlDraft(cfg.baseUrl)
      setAutoApply(cfg.autoApply)
      setAutoPreview(cfg.autoPreview)
      setMaxPreviewPages(cfg.maxPreviewPages || 2)
      setSkills(sk.skills || [])
      setMcpTokens(tk.tokens || [])
      setSessions(sessRes.sessions || [])
      if (sessRes.sessions && sessRes.sessions.length > 0) {
        await loadSessionMessages(sessRes.sessions[0].id)
      }
    } catch (err) {
      setConfigStatus(
        err instanceof Error ? err.message : 'Failed to load AI configuration'
      )
    }
  }, [projectId, loadSessionMessages])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveStatus, liveTools])

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault()
    setConfigStatus('Saving...')
    try {
      const updated = await aiApi.updateConfig({
        provider: providerDraft,
        model: modelDraft,
        baseUrl: baseUrlDraft,
        apiKey: apiKeyDraft || undefined,
        apiKeyProvider: providerDraft,
        autoApply,
        autoPreview,
        maxPreviewPages,
      })
      setConfig(updated)
      setApiKeyDraft('')
      setConfigStatus('Saved encrypted settings.')
    } catch (err) {
      setConfigStatus(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const handleTestConnection = async () => {
    setTestingConn(true)
    setConfigStatus('Testing connection...')
    try {
      const res = await aiApi.testConnection({
        provider: providerDraft,
        model: modelDraft,
        baseUrl: baseUrlDraft,
        apiKey: apiKeyDraft || undefined,
      })
      setConfigStatus(
        `Connection OK (${res.provider}: ${res.model}) in ${res.latencyMs}ms.`
      )
    } catch (err) {
      setConfigStatus(
        `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      )
    } finally {
      setTestingConn(false)
    }
  }

  const handleClearKey = async () => {
    try {
      const updated = await aiApi.updateConfig({
        apiKeyProvider: providerDraft,
        clearApiKey: true,
      })
      setConfig(updated)
      setConfigStatus(`Cleared ${PROVIDER_LABELS[providerDraft]} API key.`)
    } catch (err) {
      setConfigStatus(err instanceof Error ? err.message : 'Failed to clear key')
    }
  }

  const handleNewChat = async () => {
    if (!projectId) return
    setActiveSessionId(null)
    setMessages([])
    setLiveStatus(null)
    setLiveTools([])
  }

  const handleDeleteSession = async () => {
    if (!projectId || !activeSessionId) return
    await aiApi.deleteSession(projectId, activeSessionId)
    const next = sessions.filter(s => s.id !== activeSessionId)
    setSessions(next)
    if (next.length > 0) {
      await loadSessionMessages(next[0].id)
    } else {
      setActiveSessionId(null)
      setMessages([])
    }
  }

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).slice(0, 4)
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const commaIdx = result.indexOf(',')
        if (commaIdx === -1) return
        const base64 = result.slice(commaIdx + 1)
        setAttachedImages(prev => [
          ...prev.slice(-3),
          {
            name: file.name,
            mimeType: file.type || 'image/png',
            base64,
          },
        ])
      }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const sendMessage = async (promptText?: string) => {
    const text = (promptText ?? input).trim()
    if (!text || sending || !projectId) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      images: attachedImages.length > 0 ? [...attachedImages] : undefined,
    }

    const history = messages
      .filter(m => !m.error)
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content }))

    setMessages(prev => [...prev, userMsg])
    if (!promptText) setInput('')
    const imgsToSend = [...attachedImages]
    const snippetToSend = selectedSnippet
    setAttachedImages([])
    setSelectedSnippet('')
    setSending(true)
    setLiveStatus('Connecting to AI...')
    setLiveTools([])

    try {
      const res = await aiApi.chatStream(
        projectId,
        {
          sessionId: activeSessionId,
          message: text,
          history,
          activeDocPath: getCurrentOpenDocPath(),
          selectedText: snippetToSend || null,
          images: imgsToSend,
          autoApply,
          autoPreview,
        },
        evt => {
          if (evt.type === 'status') {
            setLiveStatus(evt.message)
          } else if (evt.type === 'tool_start') {
            setLiveStatus(`Running tool: ${evt.tool}...`)
            setLiveTools(prev => [...prev, `${evt.tool} (running)`])
          } else if (evt.type === 'tool_end') {
            setLiveTools(prev => {
              const copy = [...prev]
              if (copy.length > 0) {
                copy[copy.length - 1] = `${evt.tool}${
                  evt.imageCount > 0 ? ` (+${evt.imageCount} img)` : ''
                } ✓`
              }
              return copy
            })
          }
        }
      )

      setMessages(prev => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: res.reply,
          proposedEdits: res.proposedEdits,
          previewPages: res.previewPages,
          toolTrace: res.toolTrace,
        },
      ])

      if (res.sessionId) {
        setActiveSessionId(res.sessionId)
        const updatedList = await aiApi.listSessions(projectId)
        setSessions(updatedList.sessions || [])
      }

      if (autoApply && (res.proposedEdits || []).some(e => e.applied)) {
        triggerOverleafPdfRecompile()
      }
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: '',
          error: err instanceof Error ? err.message : 'AI request failed',
        },
      ])
    } finally {
      setSending(false)
      setLiveStatus(null)
      setLiveTools([])
    }
  }

  const handleApplyEdit = async (msgId: string, edit: ProposedEdit) => {
    if (!projectId) return
    setApplyingId(edit.id)
    try {
      await aiApi.applyEdit(projectId, edit.path, edit.newContent)
      setMessages(prev =>
        prev.map(m =>
          m.id !== msgId
            ? m
            : {
                ...m,
                proposedEdits: (m.proposedEdits || []).map(pe =>
                  pe.id === edit.id
                    ? { ...pe, applied: true, reverted: false }
                    : pe
                ),
              }
        )
      )
      triggerOverleafPdfRecompile()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to apply edit')
    } finally {
      setApplyingId(null)
    }
  }

  const handleApplyAll = async (msgId: string, edits: ProposedEdit[]) => {
    if (!projectId) return
    const pending = edits.filter(e => !e.applied && !e.dismissed)
    for (const edit of pending) {
      await handleApplyEdit(msgId, edit)
    }
  }

  const handleRevertEdit = async (msgId: string, edit: ProposedEdit) => {
    if (!projectId) return
    setApplyingId(edit.id)
    try {
      await aiApi.applyEdit(projectId, edit.path, edit.oldContent || '')
      setMessages(prev =>
        prev.map(m =>
          m.id !== msgId
            ? m
            : {
                ...m,
                proposedEdits: (m.proposedEdits || []).map(pe =>
                  pe.id === edit.id
                    ? { ...pe, applied: false, reverted: true }
                    : pe
                ),
              }
        )
      )
      triggerOverleafPdfRecompile()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to revert edit')
    } finally {
      setApplyingId(null)
    }
  }

  const handleDismissEdit = (msgId: string, editId: string) => {
    setMessages(prev =>
      prev.map(m =>
        m.id !== msgId
          ? m
          : {
              ...m,
              proposedEdits: (m.proposedEdits || []).map(pe =>
                pe.id === editId ? { ...pe, dismissed: true } : pe
              ),
            }
      )
    )
  }

  const handleToggleSkill = async (skill: AiSkillItem) => {
    const res = await aiApi.updateSkill(skill.id, { enabled: !skill.enabled })
    setSkills(prev => prev.map(s => (s.id === skill.id ? res.skill : s)))
  }

  const handleCreateSkill = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newSkillName.trim() || !newSkillBody.trim()) return
    setSkillStatus('Installing skill...')
    try {
      const res = await aiApi.createSkill({
        name: newSkillName,
        description: newSkillDesc,
        instructions: newSkillBody,
        source: 'manual',
      })
      setSkills(prev => [
        res.skill,
        ...prev.filter(s => s.id !== res.skill.id),
      ])
      setNewSkillName('')
      setNewSkillDesc('')
      setNewSkillBody('')
      setSkillStatus(`Installed skill "${res.skill.name}".`)
    } catch (err) {
      setSkillStatus(err instanceof Error ? err.message : 'Failed to save skill')
    }
  }

  const handleSkillFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const res = await aiApi.createSkill({
          name: file.name.replace(/\.md$/i, ''),
          markdown: String(reader.result || ''),
          source: 'upload',
        })
        setSkills(prev => [
          res.skill,
          ...prev.filter(s => s.id !== res.skill.id),
        ])
        setSkillStatus(`Installed skill "${res.skill.name}" from file.`)
      } catch (err) {
        setSkillStatus(err instanceof Error ? err.message : 'Upload failed')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleImportSkillUrl = async () => {
    if (!skillUrl.trim()) return
    setSkillStatus('Downloading skill...')
    try {
      const res = await aiApi.importSkillFromUrl(skillUrl.trim())
      setSkills(prev => [
        res.skill,
        ...prev.filter(s => s.id !== res.skill.id),
      ])
      setSkillUrl('')
      setSkillStatus(`Installed skill "${res.skill.name}" from URL.`)
    } catch (err) {
      setSkillStatus(err instanceof Error ? err.message : 'Import failed')
    }
  }

  const handleDeleteSkill = async (skillId: string) => {
    await aiApi.deleteSkill(skillId)
    setSkills(prev => prev.filter(s => s.id !== skillId))
  }

  const handleCreateMcpToken = async () => {
    setMcpStatus('Generating token...')
    try {
      const res = await aiApi.createMcpToken(
        newTokenName.trim() || 'External AI Client',
        newTokenScope
      )
      setFreshRawToken(res.token.rawToken || null)
      setMcpTokens(prev => [...prev, res.token])
      setMcpStatus(
        `Token created (${res.token.scope === 'read' ? 'Read-Only' : 'Read & Write'}). Copy it now—it will not be shown again.`
      )
    } catch (err) {
      setMcpStatus(err instanceof Error ? err.message : 'Failed to create token')
    }
  }

  const handleRevokeMcpToken = async (tokenId: string) => {
    await aiApi.revokeMcpToken(tokenId)
    setMcpTokens(prev => prev.filter(t => t.id !== tokenId))
  }

  const activeSkillsCount = skills.filter(s => s.enabled).length
  const isConfigured = Boolean(
    config?.model &&
      (config.provider === 'custom'
        ? config.baseUrl
        : config.apiKeys?.[config.provider]?.configured)
  )

  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        overleaf: {
          type: 'http',
          url: mcpEndpointUrl,
          headers: {
            Authorization: `Bearer ${freshRawToken || '<YOUR_OVERLEAF_MCP_TOKEN>'}`,
          },
        },
      },
    },
    null,
    2
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bs-body-bg, #ffffff)',
        color: 'var(--bs-body-color, #1e293b)',
        fontSize: '13px',
      }}
    >
      {/* Header & Tabs */}
      <div
        style={{
          padding: '10px 12px 6px',
          borderBottom: '1px solid var(--bs-border-color, #e2e8f0)',
          background: 'var(--bs-tertiary-bg, #f8fafc)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}
        >
          <strong style={{ fontSize: '14px' }}>AI LaTeX Assistant</strong>
          <span
            style={{
              fontSize: '11px',
              padding: '2px 6px',
              borderRadius: '999px',
              background: isConfigured
                ? 'rgba(22, 163, 74, 0.15)'
                : 'rgba(217, 119, 6, 0.15)',
              color: isConfigured ? '#15803d' : '#b45309',
            }}
          >
            {isConfigured
              ? `${config?.provider}: ${config?.model}`
              : 'Configure AI'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '4px' }}>
          {(
            [
              ['chat', 'Chat'],
              ['skills', `Skills (${activeSkillsCount})`],
              ['mcp', 'MCP'],
              ['settings', 'Settings'],
            ] as [PanelTab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              style={{
                flex: 1,
                padding: '5px 6px',
                fontSize: '12px',
                borderRadius: '6px',
                border: '1px solid',
                borderColor:
                  activeTab === id
                    ? '#15803d'
                    : 'var(--bs-border-color, #cbd5e1)',
                background:
                  activeTab === id ? '#15803d' : 'var(--bs-body-bg, #ffffff)',
                color:
                  activeTab === id
                    ? '#ffffff'
                    : 'var(--bs-body-color, #334155)',
                cursor: 'pointer',
                fontWeight: activeTab === id ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* CHAT TAB */}
      {activeTab === 'chat' && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Persistent Session Bar */}
          <div
            style={{
              padding: '6px 10px',
              borderBottom: '1px solid var(--bs-border-color, #e2e8f0)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'var(--bs-tertiary-bg, #f8fafc)',
            }}
          >
            <select
              value={activeSessionId || ''}
              onChange={e => {
                if (e.target.value) void loadSessionMessages(e.target.value)
              }}
              style={{
                flex: 1,
                padding: '3px 6px',
                fontSize: '11px',
                borderRadius: '5px',
                border: '1px solid var(--bs-border-color, #cbd5e1)',
                background: 'var(--bs-body-bg, #fff)',
                color: 'var(--bs-body-color, #1e293b)',
              }}
            >
              {!activeSessionId && <option value="">New Chat</option>}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.messageCount})
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void handleNewChat()} style={quickBtnStyle}>
              + New
            </button>
            {activeSessionId && (
              <button
                type="button"
                onClick={() => void handleDeleteSession()}
                style={{ ...quickBtnStyle, color: '#dc2626' }}
                title="Delete chat session"
              >
                ×
              </button>
            )}
          </div>

          {/* Mode toggles + Quick actions */}
          <div
            style={{
              padding: '8px 10px',
              borderBottom: '1px solid var(--bs-border-color, #e2e8f0)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '12px',
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={autoApply}
                  onChange={e => setAutoApply(e.target.checked)}
                />
                Auto-Apply
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={autoPreview}
                  onChange={e => setAutoPreview(e.target.checked)}
                />
                Auto-Preview PDF
              </label>
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={sending}
                onClick={() =>
                  void sendMessage(
                    'Compile this project, inspect the rendered PDF preview and LaTeX log, and report any visual or compilation issues.'
                  )
                }
                style={quickBtnStyle}
              >
                Compile & Visual QA
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() =>
                  void sendMessage(
                    'Read my main LaTeX files and fix any LaTeX syntax, formatting, or citation issues.'
                  )
                }
                style={quickBtnStyle}
              >
                Fix LaTeX
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() =>
                  void sendMessage(
                    'Review the active document structure and improve the academic writing clarity while preserving all LaTeX commands.'
                  )
                }
                style={quickBtnStyle}
              >
                Polish Writing
              </button>
            </div>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            {!isConfigured && (
              <div
                style={{
                  padding: '10px',
                  borderRadius: '6px',
                  background: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid rgba(245, 158, 11, 0.45)',
                  fontSize: '12px',
                }}
              >
                Belum ada provider AI aktif. Buka tab{' '}
                <button
                  type="button"
                  onClick={() => setActiveTab('settings')}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: '#15803d',
                    textDecoration: 'underline',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                >
                  Settings
                </button>{' '}
                untuk memilih Anthropic / Gemini / OpenAI / Custom dan mengisi
                nama model + API Key Anda.
              </div>
            )}

            {messages.length === 0 && (
              <div
                style={{
                  color: 'var(--bs-secondary-color, #64748b)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                }}
              >
                Tanyakan apa saja tentang dokumen LaTeX Anda. AI dapat membaca
                struktur proyek, melihat gambar/diagram, mencari sitasi BibTeX
                dari DOI/arXiv, membuat &amp; mengedit file, serta melakukan
                compile &amp; preview PDF otomatis.
              </div>
            )}

            {messages.map(msg => {
              const pendingEdits = (msg.proposedEdits || []).filter(
                e => !e.applied && !e.dismissed
              )
              return (
                <div
                  key={msg.id}
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'stretch',
                    maxWidth: msg.role === 'user' ? '90%' : '100%',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    background:
                      msg.role === 'user'
                        ? 'rgba(22, 163, 74, 0.12)'
                        : 'var(--bs-tertiary-bg, #f8fafc)',
                    border:
                      msg.role === 'user'
                        ? '1px solid rgba(22, 163, 74, 0.35)'
                        : '1px solid var(--bs-border-color, #e2e8f0)',
                  }}
                >
                  <div
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--bs-secondary-color, #475569)',
                      marginBottom: '4px',
                    }}
                  >
                    {msg.role === 'user' ? 'You' : 'Overleaf AI'}
                  </div>

                  {msg.error && (
                    <div style={{ color: '#dc2626', whiteSpace: 'pre-wrap' }}>
                      Error: {msg.error}
                    </div>
                  )}

                  {msg.content &&
                    (msg.role === 'assistant' ? (
                      <MarkdownKatex content={msg.content} />
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                        {msg.content}
                      </div>
                    ))}

                  {/* User attached images */}
                  {msg.images && msg.images.length > 0 && (
                    <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                      {msg.images.map((img, i) => (
                        <img
                          key={i}
                          src={`data:${img.mimeType};base64,${img.base64}`}
                          alt={img.name}
                          style={{
                            maxWidth: '100px',
                            maxHeight: '80px',
                            borderRadius: '4px',
                            border: '1px solid var(--bs-border-color, #cbd5e1)',
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Tool trace */}
                  {msg.toolTrace && msg.toolTrace.length > 0 && (
                    <details
                      style={{
                        marginTop: '6px',
                        fontSize: '11px',
                        color: 'var(--bs-secondary-color, #475569)',
                      }}
                    >
                      <summary style={{ cursor: 'pointer' }}>
                        Tools used ({msg.toolTrace.length})
                      </summary>
                      <ul style={{ paddingLeft: '16px', margin: '4px 0' }}>
                        {msg.toolTrace.map((t, idx) => (
                          <li key={idx}>
                            <code>{t.tool}</code>
                            {t.imageCount > 0 ? ` (+${t.imageCount} img)` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {/* Rendered PDF preview pages */}
                  {msg.previewPages && msg.previewPages.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>
                        Compiled PDF Preview Inspected by AI:
                      </div>
                      <div style={{ display: 'flex', gap: '6px', overflowX: 'auto' }}>
                        {msg.previewPages.map(p => (
                          <img
                            key={p.page}
                            src={`data:${p.mimeType};base64,${p.base64}`}
                            alt={`PDF Page ${p.page}`}
                            style={{
                              maxHeight: '180px',
                              border: '1px solid var(--bs-border-color, #cbd5e1)',
                              borderRadius: '4px',
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Proposed Diff Cards + Apply All + Undo/Revert */}
                  {msg.proposedEdits && msg.proposedEdits.length > 0 && (
                    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {pendingEdits.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleApplyAll(msg.id, msg.proposedEdits || [])
                          }
                          style={{ ...primaryBtnStyle, alignSelf: 'flex-end', fontSize: '11px', padding: '4px 10px' }}
                        >
                          Apply All ({pendingEdits.length})
                        </button>
                      )}
                      {msg.proposedEdits.map(edit => (
                        <div
                          key={edit.id}
                          style={{
                            border: '1px solid var(--bs-border-color, #cbd5e1)',
                            borderRadius: '6px',
                            background: 'var(--bs-body-bg, #fff)',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              padding: '6px 8px',
                              background: 'var(--bs-tertiary-bg, #f1f5f9)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <div>
                              <code style={{ fontWeight: 600 }}>{edit.path}</code>
                              <div
                                style={{
                                  fontSize: '11px',
                                  color: 'var(--bs-secondary-color, #475569)',
                                }}
                              >
                                {edit.summary} ({edit.changedLines} lines)
                              </div>
                            </div>
                            {edit.applied ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ fontSize: '11px', color: '#16a34a', fontWeight: 600 }}>
                                  Applied ✓
                                </span>
                                <button
                                  type="button"
                                  disabled={applyingId === edit.id}
                                  onClick={() => void handleRevertEdit(msg.id, edit)}
                                  style={{
                                    padding: '2px 6px',
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--bs-border-color, #cbd5e1)',
                                    background: 'var(--bs-body-bg, #fff)',
                                    color: 'var(--bs-body-color, #334155)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Undo
                                </button>
                              </div>
                            ) : edit.dismissed ? (
                              <span style={{ fontSize: '11px', color: '#64748b' }}>
                                Dismissed
                              </span>
                            ) : (
                              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                {edit.reverted && (
                                  <span style={{ fontSize: '10px', color: '#b45309' }}>
                                    Reverted
                                  </span>
                                )}
                                <button
                                  type="button"
                                  disabled={applyingId === edit.id}
                                  onClick={() => void handleApplyEdit(msg.id, edit)}
                                  style={{
                                    padding: '3px 8px',
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    border: 'none',
                                    background: '#15803d',
                                    color: '#fff',
                                    cursor: 'pointer',
                                  }}
                                >
                                  {applyingId === edit.id ? 'Applying...' : 'Apply'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDismissEdit(msg.id, edit.id)}
                                  style={{
                                    padding: '3px 8px',
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--bs-border-color, #cbd5e1)',
                                    background: 'var(--bs-body-bg, #fff)',
                                    color: 'var(--bs-body-color, #334155)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Dismiss
                                </button>
                              </div>
                            )}
                          </div>
                          <ColoredDiff diff={edit.diff} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Live SSE Progress Panel */}
            {sending && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: 'var(--bs-tertiary-bg, #f1f5f9)',
                  border: '1px solid var(--bs-border-color, #cbd5e1)',
                  fontSize: '12px',
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {liveStatus || 'AI sedang bekerja...'}
                </div>
                {liveTools.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                    {liveTools.map((t, idx) => (
                      <span
                        key={idx}
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: '999px',
                          background: 'rgba(22, 163, 74, 0.14)',
                          color: '#15803d',
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input composer */}
          <div
            style={{
              padding: '8px 10px',
              borderTop: '1px solid var(--bs-border-color, #e2e8f0)',
              background: 'var(--bs-tertiary-bg, #f8fafc)',
            }}
          >
            {selectedSnippet && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '4px 8px',
                  marginBottom: '6px',
                  borderRadius: '5px',
                  background: 'rgba(59, 130, 246, 0.12)',
                  border: '1px solid rgba(59, 130, 246, 0.35)',
                  fontSize: '11px',
                }}
              >
                <span>
                  Selection attached ({selectedSnippet.length} chars)
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedSnippet('')}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}
                >
                  ×
                </button>
              </div>
            )}

            {attachedImages.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' }}>
                {attachedImages.map((img, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 6px',
                      background: 'var(--bs-border-color, #e2e8f0)',
                      borderRadius: '4px',
                      fontSize: '11px',
                    }}
                  >
                    <span>{img.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachedImages(prev => prev.filter((_, i) => i !== idx))
                      }
                      style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              rows={3}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void sendMessage()
                }
              }}
              placeholder="Tulis instruksi LaTeX... (Ctrl+Enter untuk kirim)"
              style={{
                width: '100%',
                resize: 'vertical',
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--bs-border-color, #cbd5e1)',
                background: 'var(--bs-body-bg, #fff)',
                color: 'var(--bs-body-color, #1e293b)',
                fontSize: '12px',
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: '6px',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', gap: '4px' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImagePick}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  style={quickBtnStyle}
                >
                  + Image
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const sel = captureEditorSelection()
                    if (sel) {
                      setSelectedSnippet(sel)
                    } else {
                      alert('Highlight teks di editor LaTeX terlebih dahulu.')
                    }
                  }}
                  style={quickBtnStyle}
                >
                  + Selection
                </button>
              </div>
              <button
                type="button"
                disabled={sending || !input.trim()}
                onClick={() => void sendMessage()}
                style={{
                  ...primaryBtnStyle,
                  cursor: sending ? 'wait' : 'pointer',
                }}
              >
                {sending ? 'Working...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SKILLS TAB */}
      {activeTab === 'skills' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '12px', color: 'var(--bs-secondary-color, #475569)' }}>
            Install &amp; aktifkan writing skills (format IEEE, gaya akademik, proofreading, dsb.) yang otomatis disuntikkan ke AI saat membantu penulisan.
          </div>

          {skillStatus && (
            <div style={statusBannerStyle}>{skillStatus}</div>
          )}

          {/* Installed skills list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {skills.map(skill => (
              <div
                key={skill.id}
                style={{
                  padding: '8px',
                  border: '1px solid var(--bs-border-color, #e2e8f0)',
                  borderRadius: '6px',
                  background: skill.enabled
                    ? 'var(--bs-tertiary-bg, #f8fafc)'
                    : 'var(--bs-body-bg, #fff)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: 0, fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={() => void handleToggleSkill(skill)}
                    />
                    {skill.name}
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleDeleteSkill(skill.id)}
                    style={{ border: 'none', background: 'none', color: '#dc2626', fontSize: '11px', cursor: 'pointer' }}
                  >
                    Delete
                  </button>
                </div>
                {skill.description && (
                  <div style={{ fontSize: '11px', color: 'var(--bs-secondary-color, #64748b)', marginTop: '4px' }}>
                    {skill.description}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Upload SKILL.md or import from URL */}
          <div style={{ borderTop: '1px solid var(--bs-border-color, #e2e8f0)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <strong style={{ fontSize: '12px' }}>Install Skill from File or URL (SSRF-Protected)</strong>
            <div>
              <input
                ref={skillFileRef}
                type="file"
                accept=".md,.txt"
                onChange={handleSkillFileUpload}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => skillFileRef.current?.click()}
                style={quickBtnStyle}
              >
                Upload SKILL.md File
              </button>
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="url"
                value={skillUrl}
                onChange={e => setSkillUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/.../SKILL.md"
                style={inputStyle}
              />
              <button type="button" onClick={() => void handleImportSkillUrl()} style={quickBtnStyle}>
                Import
              </button>
            </div>
          </div>

          {/* Manual skill form */}
          <form
            onSubmit={handleCreateSkill}
            style={{ borderTop: '1px solid var(--bs-border-color, #e2e8f0)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}
          >
            <strong style={{ fontSize: '12px' }}>Create Custom Writing Skill</strong>
            <input
              type="text"
              placeholder="Skill name (e.g. IEEE Conference Format)"
              value={newSkillName}
              onChange={e => setNewSkillName(e.target.value)}
              style={inputStyle}
              required
            />
            <input
              type="text"
              placeholder="Short description"
              value={newSkillDesc}
              onChange={e => setNewSkillDesc(e.target.value)}
              style={inputStyle}
            />
            <textarea
              rows={4}
              placeholder="Instructions (Markdown)..."
              value={newSkillBody}
              onChange={e => setNewSkillBody(e.target.value)}
              style={inputStyle}
              required
            />
            <button type="submit" style={primaryBtnStyle}>
              Install Skill
            </button>
          </form>
        </div>
      )}

      {/* MCP TAB */}
      {activeTab === 'mcp' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '12px', color: 'var(--bs-secondary-color, #475569)', lineHeight: 1.5 }}>
            Hubungkan AI Chat eksternal (Claude Desktop, Cursor, Windsurf, dll.) ke Overleaf melalui Streamable HTTP MCP Server dengan pilihan izin <strong>Read &amp; Write</strong> atau <strong>Read-Only</strong>.
          </div>

          <div>
            <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '2px' }}>MCP Endpoint URL</div>
            <code style={{ display: 'block', padding: '6px 8px', background: 'var(--bs-tertiary-bg, #f1f5f9)', borderRadius: '6px', wordBreak: 'break-all' }}>
              {mcpEndpointUrl}
            </code>
          </div>

          {mcpStatus && <div style={statusBannerStyle}>{mcpStatus}</div>}

          {freshRawToken && (
            <div style={{ padding: '8px', background: 'rgba(234, 179, 8, 0.14)', border: '1px solid rgba(234, 179, 8, 0.5)', borderRadius: '6px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600 }}>New Bearer Token (copy now):</div>
              <code style={{ display: 'block', wordBreak: 'break-all', fontSize: '11px', marginTop: '4px' }}>
                {freshRawToken}
              </code>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="text"
                value={newTokenName}
                onChange={e => setNewTokenName(e.target.value)}
                placeholder="Token label"
                style={inputStyle}
              />
              <select
                value={newTokenScope}
                onChange={e => setNewTokenScope(e.target.value as McpTokenScope)}
                style={{ ...inputStyle, width: 'auto' }}
              >
                <option value="write">Read &amp; Write</option>
                <option value="read">Read-Only</option>
              </select>
            </div>
            <button type="button" onClick={() => void handleCreateMcpToken()} style={primaryBtnStyle}>
              Generate MCP Token
            </button>
          </div>

          {/* Token list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <strong style={{ fontSize: '12px' }}>Active Tokens ({mcpTokens.length})</strong>
            {mcpTokens.map(t => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 8px',
                  border: '1px solid var(--bs-border-color, #e2e8f0)',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>{t.name}</span>
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        borderRadius: '999px',
                        background:
                          t.scope === 'read'
                            ? 'rgba(59, 130, 246, 0.15)'
                            : 'rgba(22, 163, 74, 0.15)',
                        color: t.scope === 'read' ? '#2563eb' : '#15803d',
                      }}
                    >
                      {t.scope === 'read' ? 'Read-Only' : 'Read & Write'}
                    </span>
                  </div>
                  <code style={{ fontSize: '11px', color: 'var(--bs-secondary-color, #64748b)' }}>
                    {t.tokenPrefix}
                  </code>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeMcpToken(t.id)}
                  style={{ border: 'none', background: 'none', color: '#dc2626', fontSize: '11px', cursor: 'pointer' }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>

          {/* Client JSON snippet */}
          <div>
            <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>
              MCP Client Configuration (Claude Desktop / Cursor):
            </div>
            <pre
              style={{
                margin: 0,
                padding: '8px',
                background: '#0f172a',
                color: '#e2e8f0',
                borderRadius: '6px',
                fontSize: '11px',
                overflowX: 'auto',
              }}
            >
              {mcpSnippet}
            </pre>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--bs-secondary-color, #475569)' }}>
            <strong>Exposed Tools:</strong> <code>list_projects</code>,{' '}
            <code>get_project_structure</code>, <code>read_document</code>,{' '}
            <code>read_project_image</code>, <code>write_document</code>,{' '}
            <code>patch_document</code>, <code>delete_file</code>,{' '}
            <code>compile_and_preview</code>, <code>lookup_bibtex</code>.
          </div>
        </div>
      )}

      {/* SETTINGS TAB */}
      {activeTab === 'settings' && (
        <form
          onSubmit={handleSaveConfig}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {configStatus && <div style={statusBannerStyle}>{configStatus}</div>}

          <label style={labelStyle}>
            AI Provider
            <select
              value={providerDraft}
              onChange={e => setProviderDraft(e.target.value as AiProviderId)}
              style={inputStyle}
            >
              {(Object.keys(PROVIDER_LABELS) as AiProviderId[]).map(p => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Model Name (manual)
            <input
              type="text"
              value={modelDraft}
              onChange={e => setModelDraft(e.target.value)}
              placeholder={MODEL_PLACEHOLDERS[providerDraft]}
              style={inputStyle}
              required
            />
          </label>

          {providerDraft === 'custom' && (
            <label style={labelStyle}>
              Custom Base URL (OpenAI-compatible)
              <input
                type="url"
                value={baseUrlDraft}
                onChange={e => setBaseUrlDraft(e.target.value)}
                placeholder="https://openrouter.ai/api/v1"
                style={inputStyle}
                required
              />
            </label>
          )}

          <label style={labelStyle}>
            API Key ({PROVIDER_LABELS[providerDraft]})
            {config?.apiKeys?.[providerDraft]?.configured && (
              <span style={{ fontSize: '11px', color: '#16a34a', fontWeight: 400 }}>
                {' '}
                — Saved ({config.apiKeys[providerDraft].masked})
              </span>
            )}
            <input
              type="password"
              value={apiKeyDraft}
              onChange={e => setApiKeyDraft(e.target.value)}
              placeholder={
                config?.apiKeys?.[providerDraft]?.configured
                  ? 'Leave blank to keep existing encrypted key'
                  : 'Enter API key (encrypted in MongoDB)'
              }
              style={inputStyle}
            />
          </label>

          {config?.apiKeys?.[providerDraft]?.configured && (
            <button
              type="button"
              onClick={() => void handleClearKey()}
              style={{ ...quickBtnStyle, color: '#dc2626', alignSelf: 'flex-start' }}
            >
              Clear Saved Key
            </button>
          )}

          <label style={labelStyle}>
            Max PDF Preview Pages (1–5)
            <input
              type="number"
              min={1}
              max={5}
              value={maxPreviewPages}
              onChange={e => setMaxPreviewPages(Number(e.target.value) || 2)}
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={autoApply}
              onChange={e => setAutoApply(e.target.checked)}
            />
            Default to Auto-Apply edits (skip Diff approval)
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={autoPreview}
              onChange={e => setAutoPreview(e.target.checked)}
            />
            Default to Auto-Preview compiled PDF with Vision
          </label>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button type="submit" style={{ ...primaryBtnStyle, flex: 1 }}>
              Save Encrypted Settings
            </button>
            <button
              type="button"
              disabled={testingConn || !modelDraft.trim()}
              onClick={() => void handleTestConnection()}
              style={quickBtnStyle}
            >
              {testingConn ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: '6px',
  border: '1px solid var(--bs-border-color, #cbd5e1)',
  background: 'var(--bs-body-bg, #ffffff)',
  color: 'var(--bs-body-color, #1e293b)',
  fontSize: '12px',
  marginTop: '4px',
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontSize: '12px',
  fontWeight: 600,
}

const quickBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '11px',
  borderRadius: '5px',
  border: '1px solid var(--bs-border-color, #cbd5e1)',
  background: 'var(--bs-body-bg, #ffffff)',
  color: 'var(--bs-body-color, #334155)',
  cursor: 'pointer',
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: '6px',
  border: 'none',
  background: '#15803d',
  color: '#ffffff',
  fontWeight: 600,
  fontSize: '12px',
  cursor: 'pointer',
}

const statusBannerStyle: React.CSSProperties = {
  fontSize: '12px',
  padding: '6px 8px',
  background: 'rgba(22, 163, 74, 0.12)',
  border: '1px solid rgba(22, 163, 74, 0.35)',
  borderRadius: '6px',
}
