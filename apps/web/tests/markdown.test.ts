import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/markdown'

describe('Agent Markdown rendering', () => {
  it('renders common Markdown and safe external links', () => {
    const html = renderMarkdown('## Result\n\n- one\n- two\n\n[docs](https://example.com)\n\n```ts\nconst ok = true\n```')
    expect(html).toContain('<h2>Result</h2>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('<code class="language-ts">')
  })

  it('does not allow raw HTML or javascript links', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1))')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&lt;script&gt;')
  })
})
