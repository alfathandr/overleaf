import logger from '@overleaf/logger'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import { AiUserConfig } from './AiModels.mjs'
import { hashToken } from './AiCrypto.mjs'
import {
  listUserProjects,
  getProjectStructure,
  readDocument,
  readImageFile,
  writeDocument,
  patchDocument,
  deleteEntity,
  compileAndPreview,
} from './ProjectWorkspaceService.mjs'
import { lookupBibtex } from './BibtexLookupService.mjs'

const MCP_SERVER_INFO = {
  name: 'overleaf-ai-mcp',
  version: '1.0.0',
}

const MCP_PROTOCOL_VERSION = '2025-03-26'

const MCP_TOOLS = [
  {
    name: 'list_projects',
    description:
      'List all Overleaf projects accessible to the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_project_structure',
    description:
      'Get the full folder, document (.tex/.bib/.cls/.sty), and image/file structure of an Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'read_document',
    description:
      'Read the live content of a LaTeX/text document in an Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
        path: {
          type: 'string',
          description: 'Document path (e.g. "/main.tex") or document ID',
        },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'read_project_image',
    description:
      'Read an image file (PNG/JPG/GIF/WEBP) from an Overleaf project so the AI can visually inspect it.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
        path: {
          type: 'string',
          description: 'Image path (e.g. "/figures/plot.png")',
        },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'write_document',
    description:
      'Create or overwrite a LaTeX/text document in an Overleaf project (syncs live to open editors).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
        path: {
          type: 'string',
          description: 'Document path (e.g. "/main.tex" or "/sections/intro.tex")',
        },
        content: { type: 'string', description: 'Full document text content' },
      },
      required: ['projectId', 'path', 'content'],
    },
  },
  {
    name: 'patch_document',
    description:
      'Edit an existing LaTeX/text document by replacing an exact text snippet (oldText -> newText).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
        path: { type: 'string', description: 'Document path (e.g. "/main.tex")' },
        oldText: {
          type: 'string',
          description: 'Exact existing text snippet to replace',
        },
        newText: { type: 'string', description: 'Replacement text snippet' },
      },
      required: ['projectId', 'path', 'oldText', 'newText'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a document, file, or folder from an Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
        path: { type: 'string', description: 'Path to delete (e.g. "/old.tex")' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'compile_and_preview',
    description:
      'Compile an Overleaf LaTeX project via CLSI, return LaTeX errors/warnings, and return rendered PNG preview images of the compiled PDF pages.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Overleaf project ID' },
        maxPages: {
          type: 'number',
          description: 'Maximum number of PDF pages to render as images (1-5)',
        },
        includeImages: {
          type: 'boolean',
          description: 'Whether to include rendered PNG page images (default true)',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'lookup_bibtex',
    description:
      'Fetch official BibTeX citation metadata from a DOI (e.g. "10.1145/3292500.3330701") or arXiv ID (e.g. "2303.08774").',
    inputSchema: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'DOI identifier or doi.org URL' },
        arxivId: {
          type: 'string',
          description: 'arXiv ID (e.g. "2303.08774") or arxiv.org URL',
        },
      },
      required: [],
    },
  },
]

const WRITE_TOOLS = new Set(['write_document', 'patch_document', 'delete_file'])

async function authenticateBearer(req) {
  const authHeader = req.get('Authorization') || ''
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1].trim()
  if (!token) return null

  const tokenHash = hashToken(token)
  const config = await AiUserConfig.findOne({
    'mcpTokens.tokenHash': tokenHash,
  })
  if (!config) return null

  const tokenEntry = (config.mcpTokens || []).find(
    t => t.tokenHash === tokenHash
  )
  const scope = tokenEntry?.scope === 'read' ? 'read' : 'write'

  await AiUserConfig.updateOne(
    { _id: config._id, 'mcpTokens.tokenHash': tokenHash },
    { $set: { 'mcpTokens.$.lastUsedAt': new Date() } }
  ).catch(() => {})

  return { userId: String(config.userId), scope }
}

async function assertReadAccess(userId, projectId) {
  const allowed = await AuthorizationManager.promises.canUserReadProject(
    userId,
    projectId,
    null
  )
  if (!allowed) {
    throw new Error(`Access denied: cannot read project ${projectId}`)
  }
}

async function assertWriteAccess(auth, projectId) {
  if (auth.scope !== 'write') {
    throw new Error(
      'Forbidden: this MCP token is Read-Only. Generate a Read & Write token to edit Overleaf files.'
    )
  }
  const allowed =
    await AuthorizationManager.promises.canUserWriteProjectContent(
      auth.userId,
      projectId,
      null
    )
  if (!allowed) {
    throw new Error(`Access denied: cannot edit project ${projectId}`)
  }
}

async function callMcpTool(auth, name, args = {}) {
  const { userId } = auth
  switch (name) {
    case 'list_projects': {
      const projects = await listUserProjects(userId)
      return {
        content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
      }
    }

    case 'get_project_structure': {
      await assertReadAccess(userId, args.projectId)
      const structure = await getProjectStructure(args.projectId)
      return {
        content: [{ type: 'text', text: JSON.stringify(structure, null, 2) }],
      }
    }

    case 'read_document': {
      await assertReadAccess(userId, args.projectId)
      const doc = await readDocument(args.projectId, args.path)
      return {
        content: [
          {
            type: 'text',
            text: `File: ${doc.path} (${doc.lineCount} lines)\n\n${doc.content}`,
          },
        ],
      }
    }

    case 'read_project_image': {
      await assertReadAccess(userId, args.projectId)
      const img = await readImageFile(args.projectId, args.path)
      return {
        content: [
          {
            type: 'text',
            text: `Image ${img.path} (${img.mimeType}, ${img.size} bytes)`,
          },
          {
            type: 'image',
            data: img.base64,
            mimeType: img.mimeType,
          },
        ],
      }
    }

    case 'write_document': {
      await assertWriteAccess(auth, args.projectId)
      const res = await writeDocument(
        args.projectId,
        args.path,
        args.content,
        userId
      )
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, ...res }, null, 2),
          },
        ],
      }
    }

    case 'patch_document': {
      await assertWriteAccess(auth, args.projectId)
      const res = await patchDocument(
        args.projectId,
        args.path,
        args.oldText,
        args.newText,
        userId
      )
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, ...res }, null, 2),
          },
        ],
      }
    }

    case 'delete_file': {
      await assertWriteAccess(auth, args.projectId)
      const res = await deleteEntity(args.projectId, args.path, userId)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, ...res }, null, 2),
          },
        ],
      }
    }

    case 'compile_and_preview': {
      await assertReadAccess(userId, args.projectId)
      const result = await compileAndPreview(args.projectId, userId, {
        maxPages: args.maxPages || 2,
        includeImages: args.includeImages !== false,
      })
      const content = [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: result.status,
              hasPdf: result.hasPdf,
              errors: result.errors,
              warnings: result.warnings,
              renderedPages: result.previewPages.length,
            },
            null,
            2
          ),
        },
      ]
      for (const page of result.previewPages) {
        content.push({
          type: 'image',
          data: page.base64,
          mimeType: page.mimeType,
        })
      }
      return { content }
    }

    case 'lookup_bibtex': {
      const res = await lookupBibtex({
        doi: args.doi,
        arxivId: args.arxivId,
      })
      return {
        content: [
          {
            type: 'text',
            text: `BibTeX from ${res.source} (${res.identifier}):\n\n${res.bibtex}`,
          },
        ],
      }
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`)
  }
}

async function handleJsonRpcMessage(auth, msg) {
  const { userId, scope } = auth
  const { id, method, params } = msg || {}

  if (!method) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    }
  }

  // Notifications have no id and require no JSON-RPC response body
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null
  }

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
        },
      }
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    if (method === 'tools/list') {
      const visibleTools =
        scope === 'read'
          ? MCP_TOOLS.filter(t => !WRITE_TOOLS.has(t.name))
          : MCP_TOOLS
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: visibleTools },
      }
    }

    if (method === 'tools/call') {
      const toolResult = await callMcpTool(
        auth,
        params?.name,
        params?.arguments || {}
      )
      return {
        jsonrpc: '2.0',
        id,
        result: toolResult,
      }
    }

    if (method === 'resources/list') {
      const projects = await listUserProjects(userId)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resources: projects.map(p => ({
            uri: `overleaf://project/${p.id}`,
            name: p.name,
            description: `Overleaf project (${p.access}, compiler: ${p.compiler})`,
            mimeType: 'application/json',
          })),
        },
      }
    }

    if (method === 'resources/read') {
      const uri = String(params?.uri || '')
      const m = uri.match(/^overleaf:\/\/project\/([a-f0-9]+)(?:\/(.+))?$/i)
      if (!m) {
        throw new Error(`Unsupported resource URI: ${uri}`)
      }
      const [, projectId, docPath] = m
      await assertReadAccess(userId, projectId)
      if (docPath) {
        const doc = await readDocument(projectId, decodeURIComponent(docPath))
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: doc.content,
              },
            ],
          },
        }
      }
      const structure = await getProjectStructure(projectId)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(structure, null, 2),
            },
          ],
        },
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }
  } catch (err) {
    logger.warn({ err, method, userId }, 'MCP JSON-RPC handler error')
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: err.message || 'Internal MCP error' }],
      },
    }
  }
}

export default {
  async handlePost(req, res) {
    try {
      const auth = await authenticateBearer(req)
      if (!auth) {
        return res.status(401).json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: 'Unauthorized: missing or invalid MCP Bearer token',
          },
        })
      }

      const body = req.body
      if (Array.isArray(body)) {
        const responses = []
        for (const item of body) {
          const r = await handleJsonRpcMessage(auth, item)
          if (r !== null) responses.push(r)
        }
        if (responses.length === 0) return res.status(202).end()
        return res.json(responses)
      }

      const response = await handleJsonRpcMessage(auth, body)
      if (response === null) return res.status(202).end()
      return res.json(response)
    } catch (err) {
      logger.err({ err }, 'Unhandled error in MCP POST handler')
      return res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal server error' },
      })
    }
  },

  async handleGet(req, res) {
    const auth = await authenticateBearer(req)
    if (!auth) {
      return res.status(401).json({
        error: 'Unauthorized: provide Authorization: Bearer <token>',
      })
    }

    const accept = req.get('Accept') || ''
    if (accept.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      res.write(`event: ready\ndata: ${JSON.stringify(MCP_SERVER_INFO)}\n\n`)
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n')
      }, 25000)
      req.on('close', () => clearInterval(keepAlive))
      return
    }

    const visibleTools =
      auth.scope === 'read'
        ? MCP_TOOLS.filter(t => !WRITE_TOOLS.has(t.name))
        : MCP_TOOLS

    return res.json({
      server: MCP_SERVER_INFO,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: 'streamable-http',
      scope: auth.scope,
      tools: visibleTools.map(t => ({
        name: t.name,
        description: t.description,
      })),
    })
  },
}
