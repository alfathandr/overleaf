/**
 * Fetches official BibTeX citations from DOI (Crossref/doi.org) or arXiv API.
 */

function cleanDoi(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
}

function cleanArxivId(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:\s*/i, '')
}

function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? m[1].replace(/\s+/g, ' ').trim() : ''
}

function extractAllXmlTags(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  const results = []
  let m
  while ((m = regex.exec(xml)) !== null) {
    results.push(m[1].replace(/\s+/g, ' ').trim())
  }
  return results
}

function makeCiteKey(firstAuthor, year, title) {
  const last =
    String(firstAuthor || 'author')
      .trim()
      .split(/\s+/)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'author'
  const firstWord =
    String(title || 'paper')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .find(w => w.length > 3) || 'paper'
  return `${last}${year || ''}${firstWord}`
}

export async function lookupBibtex({ doi, arxivId }) {
  if (doi && String(doi).trim()) {
    const cleaned = cleanDoi(doi)
    const url = `https://doi.org/${encodeURIComponent(cleaned)}`
    const res = await fetch(url, {
      headers: {
        Accept: 'application/x-bibtex; charset=utf-8',
        'User-Agent': 'Overleaf-AI-Assistant/1.0',
      },
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`DOI lookup failed (${res.status}) for "${cleaned}"`)
    }
    const bibtex = (await res.text()).trim()
    if (!bibtex.startsWith('@')) {
      throw new Error(`DOI "${cleaned}" did not return valid BibTeX`)
    }
    return {
      source: 'doi',
      identifier: cleaned,
      bibtex,
    }
  }

  if (arxivId && String(arxivId).trim()) {
    const cleaned = cleanArxivId(arxivId)
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleaned)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Overleaf-AI-Assistant/1.0' },
    })
    if (!res.ok) {
      throw new Error(`arXiv lookup failed (${res.status}) for "${cleaned}"`)
    }
    const xml = await res.text()
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i)
    if (!entryMatch) {
      throw new Error(`arXiv paper not found: "${cleaned}"`)
    }
    const entry = entryMatch[1]
    const title = extractXmlTag(entry, 'title')
    const published = extractXmlTag(entry, 'published')
    const year = published.slice(0, 4) || new Date().getFullYear().toString()
    const authorBlocks = extractAllXmlTags(entry, 'author')
    const authors = authorBlocks
      .map(block => extractXmlTag(block, 'name'))
      .filter(Boolean)
    const primaryCatMatch = entry.match(/primary_category[^>]*term="([^"]+)"/i)
    const primaryClass = primaryCatMatch ? primaryCatMatch[1] : ''
    const citeKey = makeCiteKey(authors[0], year, title)

    const lines = [
      `@misc{${citeKey},`,
      `  title         = {${title}},`,
      `  author        = {${authors.join(' and ')}},`,
      `  year          = {${year}},`,
      `  eprint        = {${cleaned}},`,
      `  archivePrefix = {arXiv},`,
    ]
    if (primaryClass) {
      lines.push(`  primaryClass  = {${primaryClass}},`)
    }
    lines.push(`  url           = {https://arxiv.org/abs/${cleaned}}`)
    lines.push('}')

    return {
      source: 'arxiv',
      identifier: cleaned,
      bibtex: lines.join('\n'),
    }
  }

  throw new Error('Provide either "doi" or "arxivId" to look up BibTeX')
}
