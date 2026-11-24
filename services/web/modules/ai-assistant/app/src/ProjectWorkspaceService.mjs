import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'

const execFileAsync = promisify(execFile)

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function normalizePath(p) {
  if (!p) return '/'
  let clean = String(p).trim().replace(/\\/g, '/')
  if (!clean.startsWith('/')) clean = `/${clean}`
  clean = clean.replace(/\/+/g, '/')
  return clean
}

/**
 * Lists all projects accessible to a user.
 * @param {string} userId
 */
export async function listUserProjects(userId) {
  const result = await ProjectGetter.promises.findAllUsersProjects(userId, {
    name: 1,
    lastUpdated: 1,
    compiler: 1,
    rootDoc_id: 1,
    archived: 1,
    trashed: 1,
  })

  const projects = []
  const buckets = [
    ['owned', result.owned || []],
    ['readAndWrite', result.readAndWrite || []],
    ['readOnly', result.readOnly || []],
    ['tokenReadAndWrite', result.tokenReadAndWrite || []],
    ['tokenReadOnly', result.tokenReadOnly || []],
  ]

  const seen = new Set()
  for (const [access, list] of buckets) {
    for (const p of list) {
      const id = String(p._id)
      if (seen.has(id)) continue
      seen.add(id)
      projects.push({
        id,
        name: p.name,
        access,
        compiler: p.compiler || 'pdflatex',
        lastUpdated: p.lastUpdated || null,
      })
    }
  }
  return projects
}

/**
 * Returns full project metadata and folder/doc/file structure.
 * @param {string} projectId
 */
export async function getProjectStructure(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    name: 1,
    compiler: 1,
    rootDoc_id: 1,
    rootFolder: 1,
  })
  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }

  const entities = ProjectEntityHandler.getAllEntitiesFromProject(project)
  const rootDocId = project.rootDoc_id ? String(project.rootDoc_id) : null
  let rootDocPath = null

  const docs = (entities.docs || []).map(d => {
    const id = String(d.doc._id)
    const p = normalizePath(d.path)
    if (rootDocId && id === rootDocId) {
      rootDocPath = p
    }
    return {
      id,
      path: p,
      name: d.doc.name,
      type: 'doc',
    }
  })

  const files = (entities.files || []).map(f => {
    const p = normalizePath(f.path)
    const ext = path.extname(p).toLowerCase()
    return {
      id: String(f.file._id),
      path: p,
      name: f.file.name,
      hash: f.file.hash || null,
      type: 'file',
      isImage: Boolean(IMAGE_MIME_BY_EXT[ext]),
      mimeType: IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream',
    }
  })

  const folders = (entities.folders || []).map(fl => ({
    id: String(fl.folder._id),
    path: normalizePath(fl.path),
    name: fl.folder.name,
    type: 'folder',
  }))

  return {
    projectId: String(project._id),
    name: project.name,
    compiler: project.compiler || 'pdflatex',
    rootDocId,
    rootDocPath,
    docs,
    files,
    folders,
  }
}

/**
 * Reads live document content (preferring DocumentUpdater for unsaved edits).
 * @param {string} projectId
 * @param {string} docPathOrId
 */
export async function readDocument(projectId, docPathOrId) {
  const structure = await getProjectStructure(projectId)
  const targetNorm = normalizePath(docPathOrId)
  const docEntry = structure.docs.find(
    d =>
      d.path === targetNorm ||
      d.id === docPathOrId ||
      d.path.slice(1) === docPathOrId
  )
  if (!docEntry) {
    throw new Error(`Document not found: ${docPathOrId}`)
  }

  let lines
  try {
    const live = await DocumentUpdaterHandler.promises.getDocument(
      projectId,
      docEntry.id
    )
    lines = live?.lines
  } catch (err) {
    logger.warn(
      { err, projectId, docId: docEntry.id },
      'DocumentUpdaterHandler.getDocument failed, falling back to ProjectEntityHandler.getDoc'
    )
  }

  if (!Array.isArray(lines)) {
    const fallback = await ProjectEntityHandler.promises.getDoc(
      projectId,
      docEntry.id
    )
    lines = fallback?.lines || []
  }

  return {
    id: docEntry.id,
    path: docEntry.path,
    name: docEntry.name,
    lineCount: lines.length,
    content: lines.join('\n'),
  }
}

/**
 * Reads a binary image file from Overleaf History/FileStore and returns base64.
 * @param {string} projectId
 * @param {string} filePathOrId
 */
export async function readImageFile(projectId, filePathOrId) {
  const structure = await getProjectStructure(projectId)
  const targetNorm = normalizePath(filePathOrId)
  const fileEntry = structure.files.find(
    f =>
      f.path === targetNorm ||
      f.id === filePathOrId ||
      f.path.slice(1) === filePathOrId
  )
  if (!fileEntry) {
    throw new Error(`File not found: ${filePathOrId}`)
  }
  if (!fileEntry.isImage) {
    throw new Error(
      `File is not a supported image (png/jpg/gif/webp): ${fileEntry.path}`
    )
  }
  if (!fileEntry.hash) {
    throw new Error(`File has no blob hash available: ${fileEntry.path}`)
  }

  const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
    projectId,
    fileEntry.hash,
    'GET'
  )

  const chunks = []
  let totalBytes = 0
  const MAX_BYTES = 10 * 1024 * 1024
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buf.length
    if (totalBytes > MAX_BYTES) {
      throw new Error(`Image exceeds 10MB limit: ${fileEntry.path}`)
    }
    chunks.push(buf)
  }

  const buffer = Buffer.concat(chunks)
  return {
    id: fileEntry.id,
    path: fileEntry.path,
    name: fileEntry.name,
    mimeType: fileEntry.mimeType,
    size: buffer.length,
    base64: buffer.toString('base64'),
  }
}

/**
 * Writes (creates or updates) a document by path, syncing live to open editors.
 * @param {string} projectId
 * @param {string} docPath
 * @param {string} content
 * @param {string} userId
 */
export async function writeDocument(projectId, docPath, content, userId) {
  const cleanPath = normalizePath(docPath)
  const docLines = String(content ?? '').split(/\r?\n/)
  const result = await EditorController.promises.upsertDocWithPath(
    projectId,
    cleanPath,
    docLines,
    'ai-assistant',
    userId
  )
  return {
    path: cleanPath,
    docId: result?.doc?._id ? String(result.doc._id) : null,
    lineCount: docLines.length,
  }
}

/**
 * Performs a surgical search-and-replace patch on an existing document.
 * @param {string} projectId
 * @param {string} docPath
 * @param {string} oldText
 * @param {string} newText
 * @param {string} userId
 */
export async function patchDocument(
  projectId,
  docPath,
  oldText,
  newText,
  userId
) {
  const doc = await readDocument(projectId, docPath)
  if (!oldText || !doc.content.includes(oldText)) {
    throw new Error(
      `Target snippet not found in ${doc.path}. Read the file first and provide an exact match.`
    )
  }
  const updatedContent = doc.content.replace(oldText, newText)
  return await writeDocument(projectId, doc.path, updatedContent, userId)
}

/**
 * Deletes an entity (doc/file/folder) by path.
 * @param {string} projectId
 * @param {string} entityPath
 * @param {string} userId
 */
export async function deleteEntity(projectId, entityPath, userId) {
  const cleanPath = normalizePath(entityPath)
  const entityId = await EditorController.promises.deleteEntityWithPath(
    projectId,
    cleanPath,
    'ai-assistant',
    userId
  )
  return {
    path: cleanPath,
    deletedEntityId: entityId ? String(entityId) : null,
  }
}

/**
 * Fetches an output file buffer from CLSI.
 * @param {string} projectId
 * @param {string} userId
 * @param {string} buildId
 * @param {string} filePath
 */
async function fetchClsiOutputFile(projectId, userId, buildId, filePath) {
  const clsiBase = (Settings?.apis?.clsi?.url || 'http://127.0.0.1:3013').replace(
    /\/+$/,
    ''
  )
  const candidates = [
    `${clsiBase}/project/${projectId}/user/${userId}/build/${buildId}/output/${filePath}`,
    `${clsiBase}/project/${projectId}/build/${buildId}/output/${filePath}`,
  ]
  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer()
        return Buffer.from(arrayBuf)
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

/**
 * Extracts concise LaTeX error and warning lines from output.log.
 * @param {string} logText
 */
function summarizeLatexLog(logText) {
  if (!logText) return { errors: [], warnings: [], excerpt: '' }
  const lines = logText.split(/\r?\n/)
  const errors = []
  const warnings = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('!') || /LaTeX Error:/i.test(line)) {
      errors.push(lines.slice(i, Math.min(i + 4, lines.length)).join('\n'))
    } else if (/Warning:|Overfull \\hbox|Underfull \\hbox/i.test(line)) {
      warnings.push(line)
    }
  }
  return {
    errors: errors.slice(0, 15),
    warnings: warnings.slice(0, 20),
    excerpt: lines.slice(-60).join('\n'),
  }
}

/**
 * Compiles the LaTeX project via CLSI, parses output.log, and optionally
 * renders PDF pages to PNG images using `pdftoppm` for AI visual inspection.
 * @param {string} projectId
 * @param {string} userId
 * @param {{ maxPages?: number, includeImages?: boolean }} [options]
 */
export async function compileAndPreview(projectId, userId, options = {}) {
  const maxPages = Math.min(Math.max(Number(options.maxPages) || 2, 1), 5)
  const includeImages = options.includeImages !== false

  const compileResult = await CompileManager.promises.compile(
    projectId,
    userId,
    {
      isAutoCompile: false,
    }
  )

  const status = compileResult?.status || 'unknown'
  const outputFiles = compileResult?.outputFiles || []
  const pdfFile = outputFiles.find(f => f.path === 'output.pdf')
  const logFile = outputFiles.find(f => f.path === 'output.log')
  const buildId = pdfFile?.build || logFile?.build || outputFiles[0]?.build

  let logSummary = { errors: [], warnings: [], excerpt: '' }
  if (logFile && buildId) {
    const logBuf = await fetchClsiOutputFile(
      projectId,
      userId,
      buildId,
      'output.log'
    )
    if (logBuf) {
      logSummary = summarizeLatexLog(logBuf.toString('utf8'))
    }
  }

  const previewPages = []
  if (includeImages && pdfFile && buildId) {
    const pdfBuf = await fetchClsiOutputFile(
      projectId,
      userId,
      buildId,
      'output.pdf'
    )
    if (pdfBuf) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ol-ai-preview-'))
      try {
        const pdfPath = path.join(tmpDir, 'output.pdf')
        const outPrefix = path.join(tmpDir, 'page')
        await fs.writeFile(pdfPath, pdfBuf)
        await execFileAsync('pdftoppm', [
          '-png',
          '-r',
          '150',
          '-f',
          '1',
          '-l',
          String(maxPages),
          pdfPath,
          outPrefix,
        ])
        const entries = (await fs.readdir(tmpDir))
          .filter(name => name.startsWith('page-') && name.endsWith('.png'))
          .sort()
        for (let idx = 0; idx < entries.length; idx++) {
          const pngBuf = await fs.readFile(path.join(tmpDir, entries[idx]))
          previewPages.push({
            page: idx + 1,
            mimeType: 'image/png',
            base64: pngBuf.toString('base64'),
          })
        }
      } catch (err) {
        logger.warn(
          { err, projectId },
          'Failed to render PDF preview images via pdftoppm'
        )
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  return {
    status,
    buildId: buildId || null,
    hasPdf: Boolean(pdfFile),
    errors: logSummary.errors,
    warnings: logSummary.warnings,
    logExcerpt: logSummary.excerpt,
    previewPages,
  }
}

/**
 * Builds a unified-style line diff preview between oldText and newText.
 * @param {string} oldText
 * @param {string} newText
 */
export function buildSimpleDiff(oldText, newText) {
  const oldLines = String(oldText || '').split(/\r?\n/)
  const newLines = String(newText || '').split(/\r?\n/)
  const maxLen = Math.max(oldLines.length, newLines.length)
  const diffLines = []
  let changes = 0

  for (let i = 0; i < maxLen; i++) {
    const a = oldLines[i]
    const b = newLines[i]
    if (a === b) {
      if (diffLines.length > 0 && diffLines.length < 160) {
        diffLines.push(`  ${a ?? ''}`)
      }
    } else {
      changes++
      if (a !== undefined) diffLines.push(`- ${a}`)
      if (b !== undefined) diffLines.push(`+ ${b}`)
    }
    if (diffLines.length >= 200) {
      diffLines.push('... (diff truncated)')
      break
    }
  }

  return {
    changedLines: changes,
    diff: diffLines.join('\n'),
  }
}
