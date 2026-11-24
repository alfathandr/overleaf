import { describe, it, expect } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  maskSecret,
  generateMcpToken,
  hashToken,
} from '../../app/src/AiCrypto.mjs'
import { parseSkillMarkdown } from '../../app/src/AiModels.mjs'
import { buildSimpleDiff } from '../../app/src/ProjectWorkspaceService.mjs'
import { isPrivateIp, assertSafeExternalUrl } from '../../app/src/AiSecurity.mjs'
import { lookupBibtex } from '../../app/src/BibtexLookupService.mjs'

describe('AI Assistant core utilities', () => {
  it('encrypts and decrypts API keys round-trip using AES-256-GCM', () => {
    const secret = 'sk-ant-api03-test-secret-key-987654321'
    const encrypted = encryptSecret(secret)
    expect(encrypted).not.toContain(secret)
    expect(encrypted.split(':')).toHaveLength(3)
    expect(decryptSecret(encrypted)).toBe(secret)
  })

  it('masks secrets safely', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('sk-1...abcd')
    expect(maskSecret('short')).toBe('****')
  })

  it('generates prefixed MCP tokens with matching SHA-256 hashes', () => {
    const { raw, tokenHash, tokenPrefix } = generateMcpToken()
    expect(raw.startsWith('olmcp_')).toBe(true)
    expect(hashToken(raw)).toBe(tokenHash)
    expect(tokenPrefix).toContain('olmcp_')
  })

  it('parses SKILL.md with YAML frontmatter', () => {
    const md = `---
name: IEEE LaTeX Formatter
description: Enforces IEEEtran two-column conventions.
---
Always use \\documentclass[conference]{IEEEtran} and \\cite{} for references.`
    const parsed = parseSkillMarkdown(md)
    expect(parsed.name).toBe('IEEE LaTeX Formatter')
    expect(parsed.slug).toBe('ieee-latex-formatter')
    expect(parsed.description).toBe('Enforces IEEEtran two-column conventions.')
    expect(parsed.instructions).toContain('IEEEtran')
  })

  it('builds a readable diff preview between old and new LaTeX content', () => {
    const res = buildSimpleDiff(
      '\\section{Intro}\nHello world.',
      '\\section{Introduction}\nHello Overleaf AI.'
    )
    expect(res.changedLines).toBe(2)
    expect(res.diff).toContain('- \\section{Intro}')
    expect(res.diff).toContain('+ \\section{Introduction}')
  })

  it('blocks private, loopback, and metadata IPs/URLs (SSRF protection)', async () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('10.0.0.5')).toBe(true)
    expect(isPrivateIp('169.254.169.254')).toBe(true)
    expect(isPrivateIp('192.168.1.10')).toBe(true)
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('8.8.8.8')).toBe(false)

    const blockedUrls = [
      'http://localhost:8080/skill.md',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
    ]
    for (const url of blockedUrls) {
      let threw = false
      try {
        await assertSafeExternalUrl(url)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    }
  })

  it('validates lookupBibtex input requirements', async () => {
    let message = ''
    try {
      await lookupBibtex({})
    } catch (err) {
      message = err.message
    }
    expect(message).toContain('Provide either')
  })
})
