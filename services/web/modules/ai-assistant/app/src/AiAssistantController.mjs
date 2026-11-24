import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import {
  AiUserConfig,
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
import { runAiChatTurn } from './AiProviderClient.mjs'
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

  // -------------------------------------------------------------------------
  // Skills Management
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
      if (!url || !/^https?:\/\//i.test(String(url).trim())) {
        return res
          .status(400)
          .json({ error: 'Please provide a valid http(s) URL to a SKILL.md file' })
      }
      const cleanUrl = String(url).trim()
      const response = await fetch(cleanUrl, {
        headers: { Accept: 'text/plain, text/markdown, */*' },
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
            sourceUrl: cleanUrl,
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
      logger.err({ err }, 'Failed to import AI skill from URL')
      return res.status(500).json({ error: err.message })
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
  // MCP Token Management
  // -------------------------------------------------------------------------

  async listMcpTokens(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const config = await getOrCreateUserConfig(userId)
      return res.json({
        tokens: (config.mcpTokens || []).map(t => ({
          id: t.id,
          name: t.name,
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
      const { raw, tokenHash, tokenPrefix } = generateMcpToken()
      const tokenEntry = {
        id: crypto.randomUUID(),
        name,
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
  // Project Chat, Apply Edit & Manual Visual Preview
  // -------------------------------------------------------------------------

  async chat(req, res) {
    try {
      const userId = String(AuthenticationController.getLoggedInUserId(req))
      const projectId = req.params.Project_id
      const {
        message,
        history,
        activeDocPath,
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

      return res.json(result)
    } catch (err) {
      logger.warn({ err }, 'AI chat turn failed')
      return res.status(400).json({ error: err.message || 'AI request failed' })
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
