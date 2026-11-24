import mongoose from '../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose

export const VALID_PROVIDERS = ['anthropic', 'gemini', 'openai', 'custom']

const McpTokenSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    tokenHash: { type: String, required: true },
    tokenPrefix: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
  },
  { _id: false }
)

export const AiUserConfigSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    provider: {
      type: String,
      enum: VALID_PROVIDERS,
      default: 'openai',
    },
    model: { type: String, default: '' },
    baseUrl: { type: String, default: '' },
    apiKeys: {
      anthropic: { type: String, default: '' },
      gemini: { type: String, default: '' },
      openai: { type: String, default: '' },
      custom: { type: String, default: '' },
    },
    autoApply: { type: Boolean, default: false },
    autoPreview: { type: Boolean, default: true },
    maxPreviewPages: { type: Number, default: 2, min: 1, max: 5 },
    mcpTokens: { type: [McpTokenSchema], default: [] },
  },
  { timestamps: true, minimize: false }
)

AiUserConfigSchema.index({ 'mcpTokens.tokenHash': 1 })

export const AiSkillSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String, default: '' },
    instructions: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    source: {
      type: String,
      enum: ['manual', 'upload', 'url', 'builtin'],
      default: 'manual',
    },
    sourceUrl: { type: String, default: '' },
  },
  { timestamps: true, minimize: false }
)

AiSkillSchema.index({ userId: 1, slug: 1 }, { unique: true })

export const AiUserConfig =
  mongoose.models.AiUserConfig ||
  mongoose.model('AiUserConfig', AiUserConfigSchema)

export const AiSkill =
  mongoose.models.AiSkill || mongoose.model('AiSkill', AiSkillSchema)

export const DEFAULT_STARTER_SKILLS = [
  {
    name: 'Academic LaTeX Writer',
    slug: 'academic-latex-writer',
    description:
      'Produces clear, formal academic prose with proper LaTeX environments, citations, equations, and cross-references.',
    instructions: [
      'Follow rigorous academic writing standards:',
      '- Use formal, concise, objective language matching the document language (English, Indonesian, etc.).',
      '- Always use proper LaTeX semantic commands: \\label{...}, \\ref{...}, \\eqref{...}, \\cite{...}, booktabs (\\toprule, \\midrule, \\bottomrule) for tables, and amsmath environments (align, equation) for multi-line math.',
      '- Keep macros, packages, and documentclass consistent with the existing preamble.',
      '- Avoid overfull hboxes by wrapping long equations cleanly and using \\linewidth or \\textwidth for figures.',
    ].join('\n'),
    enabled: true,
    source: 'builtin',
  },
  {
    name: 'LaTeX Layout & Visual QA',
    slug: 'latex-visual-qa',
    description:
      'Compiles the document and visually inspects rendered PDF pages to fix formatting, overflow, spacing, and figure placement.',
    instructions: [
      'When making structural, table, equation, or figure edits:',
      '- Run compile_and_preview to verify zero LaTeX errors and inspect the rendered PDF pages.',
      '- Check for overlapping text, clipped tables, awkward page breaks, misaligned equations, or broken references (??).',
      '- If visual defects appear in the rendered PDF image, propose a follow-up fix and re-verify.',
    ].join('\n'),
    enabled: true,
    source: 'builtin',
  },
]

/**
 * Ensures starter skills exist for a user on first access.
 * @param {string} userId
 */
export async function ensureStarterSkills(userId) {
  const existingCount = await AiSkill.countDocuments({ userId })
  if (existingCount > 0) return
  for (const skill of DEFAULT_STARTER_SKILLS) {
    await AiSkill.updateOne(
      { userId, slug: skill.slug },
      { $setOnInsert: { ...skill, userId } },
      { upsert: true }
    )
  }
}

/**
 * Parses a SKILL.md markdown file with optional YAML frontmatter.
 * @param {string} rawMarkdown
 * @param {string} [fallbackName]
 */
export function parseSkillMarkdown(rawMarkdown, fallbackName = 'Custom Skill') {
  const text = String(rawMarkdown || '').trim()
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  let name = fallbackName
  let description = ''
  let instructions = text

  if (fmMatch) {
    const frontmatter = fmMatch[1]
    instructions = fmMatch[2].trim()
    for (const line of frontmatter.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/)
      if (!m) continue
      const key = m[1].trim().toLowerCase()
      const val = m[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name' && val) name = val
      if (key === 'description' && val) description = val
    }
  } else {
    const headingMatch = text.match(/^#\s+(.+)$/m)
    if (headingMatch) {
      name = headingMatch[1].trim()
    }
  }

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${Date.now()}`

  return {
    name,
    slug,
    description,
    instructions: instructions || text,
  }
}
