import express from 'express'
import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import AiAssistantController from './AiAssistantController.mjs'
import McpController from './McpController.mjs'

const largeJsonParser = express.json({ limit: '25mb' })

export const AiAssistantRouter = {
  apply(webRouter) {
    logger.debug({}, 'Init ai-assistant router')

    // Per-user AI provider configuration (encrypted API keys in MongoDB)
    webRouter.get(
      '/api/ai/config',
      AuthenticationController.requireLogin(),
      AiAssistantController.getConfig
    )
    webRouter.put(
      '/api/ai/config',
      AuthenticationController.requireLogin(),
      largeJsonParser,
      AiAssistantController.updateConfig
    )

    // Installable writing skills
    webRouter.get(
      '/api/ai/skills',
      AuthenticationController.requireLogin(),
      AiAssistantController.listSkills
    )
    webRouter.post(
      '/api/ai/skills',
      AuthenticationController.requireLogin(),
      largeJsonParser,
      AiAssistantController.createSkill
    )
    webRouter.post(
      '/api/ai/skills/import-url',
      AuthenticationController.requireLogin(),
      largeJsonParser,
      AiAssistantController.importSkillFromUrl
    )
    webRouter.patch(
      '/api/ai/skills/:skillId',
      AuthenticationController.requireLogin(),
      largeJsonParser,
      AiAssistantController.updateSkill
    )
    webRouter.delete(
      '/api/ai/skills/:skillId',
      AuthenticationController.requireLogin(),
      AiAssistantController.deleteSkill
    )

    // MCP Bearer token management
    webRouter.get(
      '/api/ai/mcp/tokens',
      AuthenticationController.requireLogin(),
      AiAssistantController.listMcpTokens
    )
    webRouter.post(
      '/api/ai/mcp/tokens',
      AuthenticationController.requireLogin(),
      largeJsonParser,
      AiAssistantController.createMcpToken
    )
    webRouter.delete(
      '/api/ai/mcp/tokens/:tokenId',
      AuthenticationController.requireLogin(),
      AiAssistantController.revokeMcpToken
    )

    // Project-scoped AI chat, diff apply, and visual compile preview
    webRouter.post(
      '/api/ai/project/:Project_id/chat',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      largeJsonParser,
      AiAssistantController.chat
    )
    webRouter.post(
      '/api/ai/project/:Project_id/apply',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      largeJsonParser,
      AiAssistantController.applyEdit
    )
    webRouter.post(
      '/api/ai/project/:Project_id/preview',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      largeJsonParser,
      AiAssistantController.preview
    )
  },
}

export const AiAssistantNonCsrfRouter = {
  apply(webRouter) {
    logger.debug({}, 'Init ai-assistant non-CSRF MCP router')

    // Streamable HTTP / SSE MCP Server endpoint authenticated via Bearer token
    webRouter.post('/mcp', largeJsonParser, McpController.handlePost)
    webRouter.get('/mcp', McpController.handleGet)

    if (AuthenticationController.addEndpointToLoginWhitelist) {
      AuthenticationController.addEndpointToLoginWhitelist('/mcp')
    }
  },
}
