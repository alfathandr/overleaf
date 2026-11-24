import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import {
  AiUserConfig,
  AiChatSession,
  AiSkill,
  VALID_PROVIDERS,
  ensureStarterSkills,
  parseSkillMarkdown,
} from './AiModels.mjs'
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  generateMcpToken,
} from './AiCrypto.mjs'
import { assertSafeExternalUrl } from './AiSecurity.mjs'
import { runAiChatTurn, testProviderConnection } from './AiProviderClient.mjs'
import {
  writeDocument,
  compileAndPreview,
} from './ProjectWorkspaceService.mjs'

async function getOrCreateUserConfig(userId) {
  let config = await AiUserConfig.findOne({ userId })
  if (!config) {
    config = await AiUserConfig.create({ userId })
  }
  return config
}

function serializeConfig(config) {
  const apiKeysStatus = {}
  for (const p of VALID_PROVIDERS) {
    const encrypted = config.apiKeys?.[p] || ''
    let masked = ''
    if (encrypted) {
      try {
        masked = maskSecret(decryptSecret(encrypted))
      } catch {
        masked = '****'
      }
    }
    apiKeysStatus[p] = {
      configured: Boolean(encrypted),
      masked,
    }
  }

  return {
    provider: config.provider || 'openai',
    model: config.model || '',
    baseUrl: config.baseUrl || '',
    autoApply: Boolean(config.autoApply),
    autoPreview: config.autoPreview !== false,
    maxPreviewPages: config.maxPreviewPages || 2,
    apiKeys: apiKeysStatus,
  }
}

async function resolveOrCreateSession(userId, projectId, sessionId, firstPrompt) {
  if (sessionId) {
    const existing = await AiChatSession.findOne({
      _id: sessionId,
      userId,
      projectId,
    })
    if (existing) return existing
  }
  const title =
    String(firstPrompt || 'New Chat')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60) || 'New Chat'
  return await AiChatSession.create({
    userId,
    projectId,
    title,
    messages: [],
  })
}

async function persistTurn(session, userText, assistantResult) {
  session.messages.push({
    id: `u-${crypto.randomUUID()}`,
    role: 'user',
    content: String(userText || ''),
    createdAt: new Date(),
  })
  session.messages.push({
    id: `a-${crypto.randomUUID()}`,
    role: 'assistant',
    content: String(assistantResult.reply || ''),
    proposedEdits: (assistantResult.proposedEdits || []).map(e => ({
      id: e.id,
      type: e.type,
      path: e.path,
      summary: e.summary,
      oldContent: e.oldContent,
      newContent: e.newContent,
      diff: e.diff,
      changedLines: e.changedLines,
      applied: Boolean(e.applied),
    })),
    toolTrace: assistantResult.toolTrace || [],
    createdAt: new Date(),
  })
  if (session.messages.length > 80) {
    session.messages = session.messages.slice(-80)
  }
  await session.save()
}

export default {
  async getConfig(req, res) {
    try {
      const userId = AuthenticationController.getLoggedInUserId(req)
      const config = await getOrCreateUserConfig(String(userId))
      return res.json(serializeConfig(config))
    } catch (err) {
      logger.err({ err }, 'Failed to load AI config')
      return res.status(500).json({ error: err.message })
    }
  },

  async updateConfig(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const config = await getOrCreateUserConfig(userId)
      const {
        provider,
        model,
        baseUrl,
        apiKey,
        apiKeyProvider,
        clearApiKey,
        autoApply,
        autoPreview,
        maxPreviewPages,
      } = req.body || {}

      if (provider && VALID_PROVIDERS.includes(provider)) {
        config.provider = provider
      }
      if (typeof model === 'string') {
        config.model = model.trim()
      }
      if (typeof baseUrl === 'string') {
        config.baseUrl = baseUrl.trim()
      }
      if (typeof autoApply === 'boolean') {
        config.autoApply = autoApply
      }
      if (typeof autoPreview === 'boolean') {
        config.autoPreview = autoPreview
      }
      if (maxPreviewPages != null) {
        const n = Number(maxPreviewPages)
        if (!Number.isNaN(n)) {
          config.maxPreviewPages = Math.min(Math.max(Math.round(n), 1), 5)
        }
      }

      const keyTarget =
        apiKeyProvider && VALID_PROVIDERS.includes(apiKeyProvider)
          ? apiKeyProvider
          : config.provider

      if (clearApiKey) {
        config.apiKeys[keyTarget] = ''
      } else if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
        config.apiKeys[keyTarget] = encryptSecret(apiKey.trim())
      }

      config.markModified('apiKeys')
      await config.save()
      return res.json(serializeConfig(config))
    } catch (err) {
      logger.err({ err }, 'Failed to update AI config')
      return res.status(500).json({ error: err.message })
    }
  },

  async testConnection(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const config = await getOrCreateUserConfig(userId)
      const { provider, model, baseUrl, apiKey } = req.body || {}

      const effectiveProvider =
        provider && VALID_PROVIDERS.includes(provider)
          ? provider
          : config.provider
      const effectiveModel =
        typeof model === 'string' && model.trim()
          ? model.trim()
          : config.model
      const effectiveBaseUrl =
        typeof baseUrl === 'string' && baseUrl.trim()
          ? baseUrl.trim()
          : config.baseUrl

      let effectiveApiKey =
        typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : ''
      if (!effectiveApiKey) {
        const encryptedKey = config.apiKeys?.[effectiveProvider] || ''
        effectiveApiKey = encryptedKey ? decryptSecret(encryptedKey) : ''
      }

      const result = await testProviderConnection({
        provider: effectiveProvider,
        model: effectiveModel,
        baseUrl: effectiveBaseUrl,
        apiKey: effectiveApiKey,
      })
      return res.json(result)
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: err.message || 'Connection test failed',
      })
    }
  },

  // -------------------------------------------------------------------------
  // Persistent Chat Sessions per Project
  // -------------------------------------------------------------------------

  async listSessions(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const sessions = await AiChatSession.find(
        { userId, projectId },
        { title: 1, updatedAt: 1, createdAt: 1, messages: 1 }
      )
        .sort({ updatedAt: -1 })
        .limit(30)

      return res.json({
        sessions: sessions.map(s => ({
          id: String(s._id),
          title: s.title,
          messageCount: (s.messages || []).length,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
        })),
      })
    } catch (err) {
      logger.err({ err }, 'Failed to list AI chat sessions')
      return res.status(500).json({ error: err.message })
    }
  },

  async getSession(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const { sessionId } = req.params
      const session = await AiChatSession.findOne({
        _id: sessionId,
        userId,
        projectId,
      })
      if (!session) {
        return res.status(404).json({ error: 'Chat session not found' })
      }
      return res.json({
        session: {
          id: String(session._id),
          title: session.title,
          messages: session.messages || [],
          updatedAt: session.updatedAt,
        },
      })
    } catch (err) {
      logger.err({ err }, 'Failed to get AI chat session')
      return res.status(500).json({ error: err.message })
    }
  },

  async createSession(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const title = String(req.body?.title || 'New Chat').trim().slice(0, 60)
      const session = await AiChatSession.create({
        userId,
        projectId,
        title: title || 'New Chat',
        messages: [],
      })
      return res.status(201).json({
        session: {
          id: String(session._id),
          title: session.title,
          messages: [],
          updatedAt: session.updatedAt,
        },
      })
    } catch (err) {
      logger.err({ err }, 'Failed to create AI chat session')
      return res.status(500).json({ error: err.message })
    }
  },

  async deleteSession(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const { sessionId } = req.params
      await AiChatSession.findOneAndDelete({
        _id: sessionId,
        userId,
        projectId,
      })
      return res.json({ ok: true })
    } catch (err) {
      logger.err({ err }, 'Failed to delete AI chat session')
      return res.status(500).json({ error: err.message })
    }
  },

  // -------------------------------------------------------------------------
  // Skills Management (with SSRF protection on URL import)
  // -------------------------------------------------------------------------

  async listSkills(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      await ensureStarterSkills(userId)
      const skills = await AiSkill.find({ userId }).sort({ createdAt: -1 })
      return res.json({
        skills: skills.map(s => ({
          id: String(s._id),
          name: s.name,
          slug: s.slug,
          description: s.description,
          instructions: s.instructions,
          enabled: Boolean(s.enabled),
          source: s.source,
          sourceUrl: s.sourceUrl || '',
        })),
      })
    } catch (err) {
      logger.err({ err }, 'Failed to list AI skills')
      return res.status(500).json({ error: err.message })
    }
  },

  async createSkill(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const { name, description, instructions, markdown, source } = req.body || {}

      let parsed
      if (typeof markdown === 'string' && markdown.trim()) {
        parsed = parseSkillMarkdown(markdown, name || 'Uploaded Skill')
      } else {
        if (!name || !instructions) {
          return res
            .status(400)
            .json({ error: 'Both name and instructions are required' })
        }
        parsed = {
          name: String(name).trim(),
          slug:
            String(name)
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '') || `skill-${Date.now()}`,
          description: String(description || '').trim(),
          instructions: String(instructions).trim(),
        }
      }

      const skill = await AiSkill.findOneAndUpdate(
        { userId, slug: parsed.slug },
        {
          $set: {
            name: parsed.name,
            description: parsed.description,
            instructions: parsed.instructions,
            enabled: true,
            source: source === 'upload' ? 'upload' : 'manual',
          },
        },
        { upsert: true, new: true }
      )

      return res.status(201).json({
        skill: {
          id: String(skill._id),
          name: skill.name,
          slug: skill.slug,
          description: skill.description,
          instructions: skill.instructions,
          enabled: skill.enabled,
          source: skill.source,
          sourceUrl: skill.sourceUrl || '',
        },
      })
    } catch (err) {
      logger.err({ err }, 'Failed to create AI skill')
      return res.status(500).json({ error: err.message })
    }
  },

  async importSkillFromUrl(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const { url } = req.body || {}
      const safeUrl = await assertSafeExternalUrl(url)

      const response = await fetch(safeUrl.toString(), {
        headers: { Accept: 'text/plain, text/markdown, */*' },
        redirect: 'error',
      })
      if (!response.ok) {
        return res.status(400).json({
          error: `Failed to download skill (${response.status})`,
        })
      }
      const markdown = await response.text()
      if (!markdown.trim()) {
        return res.status(400).json({ error: 'Downloaded skill file is empty' })
      }
      if (markdown.length > 200_000) {
        return res.status(400).json({ error: 'Skill file exceeds 200KB limit' })
      }

      const parsed = parseSkillMarkdown(markdown, 'Imported Skill')
      const skill = await AiSkill.findOneAndUpdate(
        { userId, slug: parsed.slug },
        {
          $set: {
            name: parsed.name,
            description: parsed.description,
            instructions: parsed.instructions,
            enabled: true,
            source: 'url',
            sourceUrl: safeUrl.toString(),
          },
        },
        { upsert: true, new: true }
      )

      return res.status(201).json({
        skill: {
          id: String(skill._id),
          name: skill.name,
          slug: skill.slug,
          description: skill.description,
          instructions: skill.instructions,
          enabled: skill.enabled,
          source: skill.source,
          sourceUrl: skill.sourceUrl || '',
        },
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to import AI skill from URL')
      return res.status(400).json({ error: err.message })
    }
  },

  async updateSkill(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const { skillId } = req.params
      const { name, description, instructions, enabled } = req.body || {}
      const update = {}
      if (typeof name === 'string' && name.trim()) update.name = name.trim()
      if (typeof description === 'string') update.description = description.trim()
      if (typeof instructions === 'string' && instructions.trim()) {
        update.instructions = instructions.trim()
      }
      if (typeof enabled === 'boolean') update.enabled = enabled

      const skill = await AiSkill.findOneAndUpdate(
        { _id: skillId, userId },
        { $set: update },
        { new: true }
      )
      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' })
      }
      return res.json({
        skill: {
          id: String(skill._id),
          name: skill.name,
          slug: skill.slug,
          description: skill.description,
          instructions: skill.instructions,
          enabled: skill.enabled,
          source: skill.source,
          sourceUrl: skill.sourceUrl || '',
        },
      })
    } catch (err) {
      logger.err({ err }, 'Failed to update AI skill')
      return res.status(500).json({ error: err.message })
    }
  },

  async deleteSkill(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const { skillId } = req.params
      const deleted = await AiSkill.findOneAndDelete({ _id: skillId, userId })
      if (!deleted) {
        return res.status(404).json({ error: 'Skill not found' })
      }
      return res.json({ ok: true })
    } catch (err) {
      logger.err({ err }, 'Failed to delete AI skill')
      return res.status(500).json({ error: err.message })
    }
  },

  // -------------------------------------------------------------------------
  // MCP Token Management (Read-Only / Read-Write Scopes)
  // -------------------------------------------------------------------------

  async listMcpTokens(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const config = await getOrCreateUserConfig(userId)
      return res.json({
        tokens: (config.mcpTokens || []).map(t => ({
          id: t.id,
          name: t.name,
          scope: t.scope === 'read' ? 'read' : 'write',
          tokenPrefix: t.tokenPrefix,
          createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt,
        })),
      })
    } catch (err) {
      logger.err({ err }, 'Failed to list MCP tokens')
      return res.status(500).json({ error: err.message })
    }
  },

  async createMcpToken(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const config = await getOrCreateUserConfig(userId)
      const name = String(req.body?.name || 'External AI Client').trim()
      const scope = req.body?.scope === 'read' ? 'read' : 'write'
      const { raw, tokenHash, tokenPrefix } = generateMcpToken()
      const tokenEntry = {
        id: crypto.randomUUID(),
        name,
        scope,
        tokenHash,
        tokenPrefix,
        createdAt: new Date(),
        lastUsedAt: null,
      }
      config.mcpTokens.push(tokenEntry)
      await config.save()
      return res.status(201).json({
        token: {
          id: tokenEntry.id,
          name: tokenEntry.name,
          scope: tokenEntry.scope,
          tokenPrefix: tokenEntry.tokenPrefix,
          createdAt: tokenEntry.createdAt,
          rawToken: raw,
        },
      })
    } catch (err) {
      logger.err({ err }, 'Failed to create MCP token')
      return res.status(500).json({ error: err.message })
    }
  },

  async revokeMcpToken(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const { tokenId } = req.params
      await AiUserConfig.updateOne(
        { userId },
        { $pull: { mcpTokens: { id: tokenId } } }
      )
      return res.json({ ok: true })
    } catch (err) {
      logger.err({ err }, 'Failed to revoke MCP token')
      return res.status(500).json({ error: err.message })
    }
  },

  // -------------------------------------------------------------------------
  // Project Chat (JSON + Live SSE Stream), Apply/Undo Edit & Visual Preview
  // -------------------------------------------------------------------------

  async chat(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const {
        sessionId,
        message,
        history,
        activeDocPath,
        selectedText,
        images,
        autoApply,
        autoPreview,
      } = req.body || {}

      if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Message is required' })
      }

      const config = await getOrCreateUserConfig(userId)
      await ensureStarterSkills(userId)
      const activeSkills = await AiSkill.find({ userId, enabled: true })
      const session = await resolveOrCreateSession(
        userId,
        projectId,
        sessionId,
        message
      )

      const encryptedKey = config.apiKeys?.[config.provider] || ''
      const apiKey = encryptedKey ? decryptSecret(encryptedKey) : ''

      const result = await runAiChatTurn({
        providerConfig: {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey,
        },
        projectId,
        userId,
        activeDocPath: activeDocPath || null,
        selectedText: selectedText || null,
        history: Array.isArray(history) ? history.slice(-16) : [],
        userMessage: String(message),
        userImages: Array.isArray(images) ? images.slice(0, 4) : [],
        activeSkills,
        autoApply:
          typeof autoApply === 'boolean' ? autoApply : Boolean(config.autoApply),
        autoPreview:
          typeof autoPreview === 'boolean'
            ? autoPreview
            : config.autoPreview !== false,
        maxPreviewPages: config.maxPreviewPages || 2,
      })

      await persistTurn(session, message, result)

      return res.json({
        ...result,
        sessionId: String(session._id),
        sessionTitle: session.title,
      })
    } catch (err) {
      logger.warn({ err }, 'AI chat turn failed')
      return res.status(400).json({ error: err.message || 'AI request failed' })
    }
  },

  async chatStream(req, res) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const sendEvent = payload => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
    }

    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const {
        sessionId,
        message,
        history,
        activeDocPath,
        selectedText,
        images,
        autoApply,
        autoPreview,
      } = req.body || {}

      if (!message || !String(message).trim()) {
        sendEvent({ type: 'error', error: 'Message is required' })
        return res.end()
      }

      const config = await getOrCreateUserConfig(userId)
      await ensureStarterSkills(userId)
      const activeSkills = await AiSkill.find({ userId, enabled: true })
      const session = await resolveOrCreateSession(
        userId,
        projectId,
        sessionId,
        message
      )

      const encryptedKey = config.apiKeys?.[config.provider] || ''
      const apiKey = encryptedKey ? decryptSecret(encryptedKey) : ''

      const result = await runAiChatTurn({
        providerConfig: {
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey,
        },
        projectId,
        userId,
        activeDocPath: activeDocPath || null,
        selectedText: selectedText || null,
        history: Array.isArray(history) ? history.slice(-16) : [],
        userMessage: String(message),
        userImages: Array.isArray(images) ? images.slice(0, 4) : [],
        activeSkills,
        autoApply:
          typeof autoApply === 'boolean' ? autoApply : Boolean(config.autoApply),
        autoPreview:
          typeof autoPreview === 'boolean'
            ? autoPreview
            : config.autoPreview !== false,
        maxPreviewPages: config.maxPreviewPages || 2,
        onProgress: evt => sendEvent(evt),
      })

      await persistTurn(session, message, result)

      sendEvent({
        type: 'done',
        ...result,
        sessionId: String(session._id),
        sessionTitle: session.title,
      })
      return res.end()
    } catch (err) {
      logger.warn({ err }, 'AI SSE chat turn failed')
      sendEvent({
        type: 'error',
        error: err.message || 'AI request failed',
      })
      return res.end()
    }
  },

  async applyEdit(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const { path: docPath, content } = req.body || {}
      if (!docPath || typeof content !== 'string') {
        return res
          .status(400)
          .json({ error: 'path and content are required to apply edit' })
      }
      const result = await writeDocument(projectId, docPath, content, userId)
      return res.json({ ok: true, ...result })
    } catch (err) {
      logger.err({ err }, 'Failed to apply AI edit')
      return res.status(500).json({ error: err.message })
    }
  },

  async preview(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const maxPages = Number(req.body?.maxPages) || 2
      const result = await compileAndPreview(projectId, userId, {
        maxPages,
        includeImages: true,
      })
      return res.json(result)
    } catch (err) {
      logger.err({ err }, 'Failed to run AI compile preview')
      return res.status(500).json({ error: err.message })
    }
  },
}
