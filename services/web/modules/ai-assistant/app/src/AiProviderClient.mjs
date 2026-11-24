import crypto from 'node:crypto'
import {
  getProjectStructure,
  readDocument,
  readImageFile,
  writeDocument,
  compileAndPreview,
  buildSimpleDiff,
} from './ProjectWorkspaceService.mjs'

const MAX_TOOL_STEPS = 8

const AI_TOOL_DEFINITIONS = [
  {
    name: 'list_project_files',
    description:
      'List all folders, LaTeX/text documents (.tex, .bib, .cls, .sty), and binary/image files in the current Overleaf project, including the root document and compiler.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the full live contents of a text/LaTeX document in the Overleaf project (e.g. "/main.tex", "/sections/intro.tex", "/references.bib").',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the document in the project (e.g. "/main.tex")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_project_image',
    description:
      'Load an image file stored in the Overleaf project (PNG, JPG, GIF, WEBP) so you can visually inspect figures, charts, diagrams, or equations.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the image file (e.g. "/figures/diagram.png")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'propose_file_edit',
    description:
      'Edit an existing LaTeX/text document in the project by replacing an exact snippet (oldText -> newText) OR replacing the full file content (fullContent). In Diff mode this presents a preview for user approval; in Auto-Apply mode it writes immediately.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Document path (e.g. "/main.tex")',
        },
        summary: {
          type: 'string',
          description: 'Short human-readable description of the change',
        },
        oldText: {
          type: 'string',
          description:
            'Exact existing snippet to replace (preferred for targeted edits)',
        },
        newText: {
          type: 'string',
          description: 'Replacement snippet for oldText',
        },
        fullContent: {
          type: 'string',
          description:
            'Full new file content (use only when creating or rewriting the entire file)',
        },
      },
      required: ['path', 'summary'],
    },
  },
  {
    name: 'create_file',
    description:
      'Create a new LaTeX/text document in the project (e.g. "/sections/method.tex" or "/references.bib").',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'New document path (e.g. "/sections/method.tex")',
        },
        content: {
          type: 'string',
          description: 'Full content of the new file',
        },
        summary: {
          type: 'string',
          description: 'Short description of why the file is created',
        },
      },
      required: ['path', 'content', 'summary'],
    },
  },
  {
    name: 'compile_and_preview',
    description:
      'Compile the Overleaf LaTeX project via CLSI, inspect LaTeX errors/warnings from output.log, and visually inspect rendered PNG images of the compiled PDF pages.',
    parameters: {
      type: 'object',
      properties: {
        maxPages: {
          type: 'number',
          description: 'Maximum number of PDF pages to render as images (1-5)',
        },
      },
      required: [],
    },
  },
]

function buildSystemPrompt({
  structure,
  activeDocPath,
  activeSkills,
  autoApply,
  autoPreview,
}) {
  const docList = (structure.docs || [])
    .map(d => `  - ${d.path}${d.path === structure.rootDocPath ? ' (root)' : ''}`)
    .join('\n')
  const fileList = (structure.files || [])
    .map(f => `  - ${f.path}${f.isImage ? ' [image]' : ''}`)
    .join('\n')

  const skillsSection =
    activeSkills && activeSkills.length > 0
      ? `\n\n## Installed Active Writing Skills\nFollow these user-installed skills carefully:\n${activeSkills
          .map(
            s =>
              `### Skill: ${s.name}\n${s.description ? `${s.description}\n` : ''}${s.instructions}`
          )
          .join('\n\n')}`
      : ''

  return `You are an expert Overleaf LaTeX Writing Assistant with full awareness of the project's file structure, LaTeX formatting, packages, bibliography, images, and live PDF preview.

## Current Overleaf Project Context
- Project Name: ${structure.name}
- Project ID: ${structure.projectId}
- Compiler: ${structure.compiler}
- Root Document: ${structure.rootDocPath || '(unset)'}
- Currently Open Document: ${activeDocPath || '(none)'}
- Edit Mode: ${autoApply ? 'AUTO-APPLY (edits are written directly to the editor)' : 'DIFF PREVIEW (propose_file_edit/create_file show a diff for the user to approve & Apply)'}
- Auto Visual Preview: ${autoPreview ? 'ENABLED (use compile_and_preview to verify LaTeX compilation and visually inspect the rendered PDF pages)' : 'OPTIONAL (only compile when asked or needed)'}

### Documents:
${docList || '  (none)'}

### Binary / Image Files:
${fileList || '  (none)'}

## Guidelines
1. Always inspect relevant files with \`read_file\` before proposing edits so your LaTeX matches the project's documentclass, macros, packages, and language.
2. When the user references a figure/image in the project or attaches an image, inspect it carefully and generate accurate LaTeX (tables, equations, TikZ, figure environments, captions, labels).
3. Use \`propose_file_edit\` with exact \`oldText\` and \`newText\` for surgical edits, or \`create_file\` for new files.
4. When Auto Visual Preview is enabled and you make or review LaTeX edits, call \`compile_and_preview\` to check for LaTeX errors/warnings and visually inspect the rendered PDF pages.
5. Respond in the same language as the user (e.g. Indonesian or English), keeping explanations clear and actionable.${skillsSection}`
}

async function executeTool(toolName, args, ctx) {
  const { projectId, userId, autoApply, maxPreviewPages, state } = ctx

  if (toolName === 'list_project_files') {
    const structure = await getProjectStructure(projectId)
    return {
      text: JSON.stringify(structure, null, 2),
      images: [],
    }
  }

  if (toolName === 'read_file') {
    const doc = await readDocument(projectId, args.path)
    return {
      text: `File: ${doc.path} (${doc.lineCount} lines)\n\n${doc.content}`,
      images: [],
    }
  }

  if (toolName === 'read_project_image') {
    const img = await readImageFile(projectId, args.path)
    return {
      text: `Loaded project image ${img.path} (${img.mimeType}, ${img.size} bytes).`,
      images: [
        {
          mimeType: img.mimeType,
          base64: img.base64,
          label: img.path,
        },
      ],
    }
  }

  if (toolName === 'propose_file_edit') {
    const targetPath = String(args.path || '')
    const summary = String(args.summary || 'Update document')
    const current = await readDocument(projectId, targetPath)
    let nextContent
    if (typeof args.oldText === 'string' && args.oldText.length > 0) {
      if (!current.content.includes(args.oldText)) {
        return {
          text: `Error: oldText snippet was not found in ${current.path}. Call read_file and provide an exact match.`,
          images: [],
        }
      }
      nextContent = current.content.replace(args.oldText, String(args.newText ?? ''))
    } else if (typeof args.fullContent === 'string') {
      nextContent = args.fullContent
    } else {
      return {
        text: 'Error: Provide either (oldText + newText) or fullContent.',
        images: [],
      }
    }

    const diffInfo = buildSimpleDiff(current.content, nextContent)
    const editRecord = {
      id: crypto.randomUUID(),
      type: 'edit',
      path: current.path,
      summary,
      oldContent: current.content,
      newContent: nextContent,
      diff: diffInfo.diff,
      changedLines: diffInfo.changedLines,
      applied: false,
    }

    if (autoApply) {
      await writeDocument(projectId, current.path, nextContent, userId)
      editRecord.applied = true
      state.proposedEdits.push(editRecord)
      return {
        text: `Applied edit directly to ${current.path} (${diffInfo.changedLines} changed lines).`,
        images: [],
      }
    }

    state.proposedEdits.push(editRecord)
    return {
      text: `Proposed edit queued for user approval on ${current.path} (${diffInfo.changedLines} changed lines).`,
      images: [],
    }
  }

  if (toolName === 'create_file') {
    const targetPath = String(args.path || '')
    const content = String(args.content ?? '')
    const summary = String(args.summary || 'Create file')
    const diffInfo = buildSimpleDiff('', content)
    const editRecord = {
      id: crypto.randomUUID(),
      type: 'create',
      path: targetPath.startsWith('/') ? targetPath : `/${targetPath}`,
      summary,
      oldContent: '',
      newContent: content,
      diff: diffInfo.diff,
      changedLines: diffInfo.changedLines,
      applied: false,
    }

    if (autoApply) {
      await writeDocument(projectId, editRecord.path, content, userId)
      editRecord.applied = true
      state.proposedEdits.push(editRecord)
      return {
        text: `Created file ${editRecord.path} directly in the project.`,
        images: [],
      }
    }

    state.proposedEdits.push(editRecord)
    return {
      text: `Proposed new file ${editRecord.path} queued for user approval.`,
      images: [],
    }
  }

  if (toolName === 'compile_and_preview') {
    const pages = Math.min(
      Math.max(Number(args.maxPages) || maxPreviewPages || 2, 1),
      5
    )
    const result = await compileAndPreview(projectId, userId, {
      maxPages: pages,
      includeImages: true,
    })

    for (const p of result.previewPages) {
      state.previewPages.push(p)
    }

    const summary = {
      status: result.status,
      hasPdf: result.hasPdf,
      errorCount: result.errors.length,
      errors: result.errors,
      warningCount: result.warnings.length,
      warnings: result.warnings.slice(0, 10),
      renderedPageCount: result.previewPages.length,
    }

    return {
      text: `Compile result:\n${JSON.stringify(summary, null, 2)}`,
      images: result.previewPages.map(p => ({
        mimeType: p.mimeType,
        base64: p.base64,
        label: `Compiled PDF Page ${p.page}`,
      })),
    }
  }

  return {
    text: `Unknown tool: ${toolName}`,
    images: [],
  }
}

// ---------------------------------------------------------------------------
// Provider Adapters (OpenAI / Custom, Anthropic, Gemini)
// ---------------------------------------------------------------------------

async function callOpenAiCompatible({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  tools,
}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const openAiMessages = [{ role: 'system', content: systemPrompt }]

  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images && m.images.length > 0) {
        const parts = []
        if (m.content) parts.push({ type: 'text', text: m.content })
        for (const img of m.images) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
            },
          })
        }
        openAiMessages.push({ role: 'user', content: parts })
      } else {
        openAiMessages.push({ role: 'user', content: m.content || '' })
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null }
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments || {}),
          },
        }))
      }
      openAiMessages.push(msg)
    } else if (m.role === 'tool') {
      openAiMessages.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content || '',
      })
      if (m.images && m.images.length > 0) {
        openAiMessages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Attached visual output from tool ${m.toolName}:`,
            },
            ...m.images.map(img => ({
              type: 'image_url',
              image_url: {
                url: `data:${img.mimeType};base64,${img.base64}`,
              },
            })),
          ],
        })
      }
    }
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: openAiMessages,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Provider error (${res.status}): ${errText.slice(0, 600)}`)
  }

  const data = await res.json()
  const choice = data?.choices?.[0]?.message || {}
  const toolCalls = (choice.tool_calls || []).map(tc => {
    let parsedArgs = {}
    try {
      parsedArgs = JSON.parse(tc.function?.arguments || '{}')
    } catch {
      parsedArgs = {}
    }
    return {
      id: tc.id || crypto.randomUUID(),
      name: tc.function?.name,
      arguments: parsedArgs,
    }
  })

  return {
    text: choice.content || '',
    toolCalls,
  }
}

async function callAnthropic({ apiKey, model, systemPrompt, messages, tools }) {
  const anthropicMessages = []

  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const img of m.images || []) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: img.base64,
          },
        })
      }
      anthropicMessages.push({ role: 'user', content: blocks })
    } else if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls || []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments || {},
        })
      }
      anthropicMessages.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool') {
      const toolBlocks = [{ type: 'text', text: m.content || '' }]
      for (const img of m.images || []) {
        toolBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: img.base64,
          },
        })
      }
      const resultBlock = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: toolBlocks,
      }
      const prev = anthropicMessages[anthropicMessages.length - 1]
      if (
        prev &&
        prev.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content.every(b => b.type === 'tool_result')
      ) {
        prev.content.push(resultBlock)
      } else {
        anthropicMessages.push({ role: 'user', content: [resultBlock] })
      }
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Anthropic error (${res.status}): ${errText.slice(0, 600)}`)
  }

  const data = await res.json()
  const blocks = data?.content || []
  const textParts = []
  const toolCalls = []

  for (const b of blocks) {
    if (b.type === 'text') textParts.push(b.text)
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id || crypto.randomUUID(),
        name: b.name,
        arguments: b.input || {},
      })
    }
  }

  return {
    text: textParts.join('\n'),
    toolCalls,
  }
}

async function callGemini({ apiKey, model, systemPrompt, messages, tools }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const contents = []
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = []
      if (m.content) parts.push({ text: m.content })
      for (const img of m.images || []) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          },
        })
      }
      contents.push({ role: 'user', parts })
    } else if (m.role === 'assistant') {
      const parts = []
      if (m.content) parts.push({ text: m.content })
      for (const tc of m.toolCalls || []) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: tc.arguments || {},
          },
        })
      }
      contents.push({ role: 'model', parts })
    } else if (m.role === 'tool') {
      const parts = [
        {
          functionResponse: {
            name: m.toolName,
            response: { result: m.content || '' },
          },
        },
      ]
      for (const img of m.images || []) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          },
        })
      }
      contents.push({ role: 'user', parts })
    }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: [
        {
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ],
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini error (${res.status}): ${errText.slice(0, 600)}`)
  }

  const data = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  const textParts = []
  const toolCalls = []

  for (const p of parts) {
    if (p.text) textParts.push(p.text)
    if (p.functionCall) {
      toolCalls.push({
        id: crypto.randomUUID(),
        name: p.functionCall.name,
        arguments: p.functionCall.args || {},
      })
    }
  }

  return {
    text: textParts.join('\n'),
    toolCalls,
  }
}

async function callProvider(providerConfig, payload) {
  const { provider, model, apiKey, baseUrl } = providerConfig
  if (!model || !model.trim()) {
    throw new Error(
      'Model name is empty. Please enter a model name in AI Settings.'
    )
  }

  if (provider === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key is not configured.')
    return await callAnthropic({ apiKey, model: model.trim(), ...payload })
  }
  if (provider === 'gemini') {
    if (!apiKey) throw new Error('Gemini API key is not configured.')
    return await callGemini({ apiKey, model: model.trim(), ...payload })
  }
  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI API key is not configured.')
    return await callOpenAiCompatible({
      baseUrl: 'https://api.openai.com/v1',
      apiKey,
      model: model.trim(),
      ...payload,
    })
  }
  if (provider === 'custom') {
    if (!baseUrl || !baseUrl.trim()) {
      throw new Error(
        'Custom provider requires a Base URL (OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1).'
      )
    }
    return await callOpenAiCompatible({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey || '',
      model: model.trim(),
      ...payload,
    })
  }

  throw new Error(`Unsupported provider: ${provider}`)
}

/**
 * Runs an agentic Overleaf AI chat turn with project context, skills, vision, and tools.
 */
export async function runAiChatTurn({
  providerConfig,
  projectId,
  userId,
  activeDocPath,
  history,
  userMessage,
  userImages,
  activeSkills,
  autoApply,
  autoPreview,
  maxPreviewPages,
}) {
  const structure = await getProjectStructure(projectId)
  const systemPrompt = buildSystemPrompt({
    structure,
    activeDocPath,
    activeSkills,
    autoApply,
    autoPreview,
  })

  const messages = []
  for (const h of history || []) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({
        role: h.role,
        content: String(h.content || ''),
      })
    }
  }

  messages.push({
    role: 'user',
    content: String(userMessage || ''),
    images: (userImages || []).map(img => ({
      mimeType: img.mimeType || 'image/png',
      base64: img.base64,
    })),
  })

  const state = {
    proposedEdits: [],
    previewPages: [],
    toolTrace: [],
  }

  let finalReply = ''

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const turn = await callProvider(providerConfig, {
      systemPrompt,
      messages,
      tools: AI_TOOL_DEFINITIONS,
    })

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      finalReply = turn.text
      break
    }

    messages.push({
      role: 'assistant',
      content: turn.text,
      toolCalls: turn.toolCalls,
    })

    for (const tc of turn.toolCalls) {
      let toolResult
      try {
        toolResult = await executeTool(tc.name, tc.arguments || {}, {
          projectId,
          userId,
          autoApply,
          maxPreviewPages,
          state,
        })
      } catch (err) {
        toolResult = {
          text: `Tool ${tc.name} failed: ${err.message}`,
          images: [],
        }
      }

      state.toolTrace.push({
        tool: tc.name,
        args: tc.arguments || {},
        preview: toolResult.text.slice(0, 240),
        imageCount: toolResult.images.length,
      })

      messages.push({
        role: 'tool',
        toolCallId: tc.id,
        toolName: tc.name,
        content: toolResult.text,
        images: toolResult.images,
      })
    }

    if (step === MAX_TOOL_STEPS - 1) {
      finalReply =
        turn.text ||
        'Completed tool execution steps. Review the proposed changes or preview below.'
    }
  }

  return {
    reply: finalReply,
    proposedEdits: state.proposedEdits,
    previewPages: state.previewPages,
    toolTrace: state.toolTrace,
  }
}
