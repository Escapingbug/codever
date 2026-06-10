export function escapeHtml(value: unknown): string {
    const str = value == null ? '' : String(value)
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

const BLOCK_TAGS = new Set([
    'plan', 'task_result', 'output', 'result', 'reason', 'thought',
    'step', 'action', 'summary', 'description', 'response', 'answer',
    'content',
])

export function sanitizeXmlLikeTags(str: string): string {
    let result = str
    let prev = ''
    let iterations = 0
    while (prev !== result && iterations < 10) {
        prev = result
        iterations++
        result = result.replace(
            /<([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
            (_, tag, content) => {
                const tagLower = tag.toLowerCase()
                const trimmed = content.trim()
                if (!trimmed) return ''
                if (BLOCK_TAGS.has(tagLower)) {
                    return `【${tagLower}】\n${trimmed}\n`
                }
                return `[${tagLower}]: ${trimmed}`
            }
        )
    }
    result = result.replace(/<([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s[^>]*)?\/>/gi, '')
    result = result.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*(?:\s[^>]*)?>/gi, '')
    return result
}

// --- HTML chunk splitting ---

/**
 * Split HTML text into chunks that respect tag boundaries.
 * Open tags are closed at chunk boundaries and re-opened in the next chunk.
 */
export function splitHtmlChunks(html: string, maxLen: number): string[] {
    const chunks: string[] = []
    let remaining = html
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) { chunks.push(remaining); break }
        const splitAt = findSafeSplitPoint(remaining, maxLen)
        let chunk = remaining.slice(0, splitAt)
        remaining = remaining.slice(splitAt)
        const openTags = getOpenTags(chunk)
        for (const tag of openTags.reverse()) chunk += `</${tag}>`
        if (openTags.length > 0) {
            const prefix = openTags.reverse().map(t => `<${t}>`).join('')
            remaining = prefix + remaining
        }
        chunks.push(chunk)
    }
    return chunks
}

function findSafeSplitPoint(text: string, maxLen: number): number {
    const chars = Array.from(text)
    const actualLen = chars.length
    if (actualLen <= maxLen) return text.length
    let pos = Math.min(maxLen, actualLen)
    while (pos > maxLen * 0.5) { if (chars[pos] === '\n') return pos + 1; pos-- }
    pos = Math.min(maxLen, actualLen)
    while (pos > maxLen * 0.5) { if (chars[pos] === ' ') return pos + 1; pos-- }
    pos = Math.min(maxLen, actualLen)
    const before = chars.slice(0, pos).join('')
    const lastOpenTag = before.lastIndexOf('<')
    const lastCloseTag = before.lastIndexOf('>')
    if (lastOpenTag > lastCloseTag) {
        const closeIdx = chars.slice(pos).join('').indexOf('>')
        if (closeIdx !== -1 && closeIdx < 200) return pos + closeIdx + 1
    }
    pos = Math.min(maxLen, actualLen)
    for (let p = pos; p > maxLen * 0.5; p--) {
        const c = chars[p]
        if (c === ' ' || c === '\n' || c === ',' || c === '。' || c === '、') return p + 1
    }
    return Math.min(pos, text.length)
}

function getOpenTags(html: string): string[] {
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g
    const openTags: string[] = []
    let match: RegExpExecArray | null
    while ((match = tagRegex.exec(html)) !== null) {
        const isClosing = match[0].startsWith('</')
        const tagName = match[1].toLowerCase()
        if (['br', 'hr', 'img', 'input'].includes(tagName)) continue
        if (isClosing) {
            const lastIdx = openTags.lastIndexOf(tagName)
            if (lastIdx !== -1) openTags.splice(lastIdx, 1)
        } else {
            openTags.push(tagName)
        }
    }
    return openTags
}
