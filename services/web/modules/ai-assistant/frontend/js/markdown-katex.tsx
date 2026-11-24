import React, { useMemo } from 'react'
import katex from 'katex'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderKatex(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
    })
  } catch {
    return `<code>${escapeHtml(expr)}</code>`
  }
}

function renderInline(text: string): string {
  // Protect inline code first
  const placeholders: string[] = []
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    const idx = placeholders.length
    placeholders.push(
      `<code style="padding:1px 4px;border-radius:4px;background:rgba(127,127,127,0.16);font-size:0.92em;">${escapeHtml(
        code
      )}</code>`
    )
    return `\u0000P${idx}\u0000`
  })

  // Render inline LaTeX math: \( ... \) and $ ... $
  out = out.replace(/\\\((.+?)\\\)/g, (_, expr) => {
    const idx = placeholders.length
    placeholders.push(renderKatex(expr, false))
    return `\u0000P${idx}\u0000`
  })
  out = out.replace(/\$([^\n$]+?)\$/g, (_, expr) => {
    const idx = placeholders.length
    placeholders.push(renderKatex(expr, false))
    return `\u0000P${idx}\u0000`
  })

  out = escapeHtml(out)
  // Bold & italic
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Restore placeholders
  out = out.replace(/\u0000P(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)] || '')
  return out
}

export const MarkdownKatex: React.FC<{ content: string }> = ({ content }) => {
  const html = useMemo(() => {
    const blocks: string[] = []
    // Extract fenced code blocks first
    let working = String(content || '').replace(
      /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g,
      (_, lang, code) => {
        const idx = blocks.length
        blocks.push(
          `<pre style="margin:6px 0;padding:8px;border-radius:6px;background:#0f172a;color:#e2e8f0;overflow:auto;font-size:11px;"><code>${escapeHtml(
            code.replace(/\n$/, '')
          )}</code></pre>`
        )
        return `\n\u0000B${idx}\u0000\n`
      }
    )

    // Extract display math blocks: $$ ... $$ and \[ ... \]
    working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
      const idx = blocks.length
      blocks.push(
        `<div style="margin:6px 0;overflow-x:auto;">${renderKatex(expr, true)}</div>`
      )
      return `\n\u0000B${idx}\u0000\n`
    })
    working = working.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
      const idx = blocks.length
      blocks.push(
        `<div style="margin:6px 0;overflow-x:auto;">${renderKatex(expr, true)}</div>`
      )
      return `\n\u0000B${idx}\u0000\n`
    })

    const lines = working.split(/\r?\n/)
    const rendered: string[] = []
    let inList = false

    for (const line of lines) {
      const blockMatch = line.trim().match(/^\u0000B(\d+)\u0000$/)
      if (blockMatch) {
        if (inList) {
          rendered.push('</ul>')
          inList = false
        }
        rendered.push(blocks[Number(blockMatch[1])] || '')
        continue
      }

      const listMatch = line.match(/^\s*[-*]\s+(.+)$/)
      if (listMatch) {
        if (!inList) {
          rendered.push('<ul style="margin:4px 0;padding-left:18px;">')
          inList = true
        }
        rendered.push(`<li>${renderInline(listMatch[1])}</li>`)
        continue
      }

      if (inList) {
        rendered.push('</ul>')
        inList = false
      }

      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
      if (headingMatch) {
        const level = Math.min(headingMatch[1].length + 2, 6)
        rendered.push(
          `<h${level} style="margin:6px 0 4px;font-weight:600;font-size:${
            level === 3 ? '14px' : '13px'
          };">${renderInline(headingMatch[2])}</h${level}>`
        )
        continue
      }

      if (!line.trim()) {
        rendered.push('<div style="height:6px;"></div>')
      } else {
        rendered.push(`<div style="line-height:1.5;">${renderInline(line)}</div>`)
      }
    }

    if (inList) rendered.push('</ul>')
    return rendered.join('')
  }, [content])

  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
