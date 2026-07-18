import { describe, expect, it } from 'vitest'
import { localFilePathFromHref, renderMarkdown } from '../src/markdown'

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

  it('marks Gateway-local file links for in-app export without making them router links', () => {
    const windows = renderMarkdown('[APK](D:/codever/dist/codever.apk)')
    const linux = renderMarkdown('[report](file:///home/user/project/report.pdf)')

    expect(windows).toContain('href="#"')
    expect(windows).toContain('data-codever-local-file="D:/codever/dist/codever.apk"')
    expect(windows).not.toContain('target="_blank"')
    expect(linux).toContain('data-codever-local-file="/home/user/project/report.pdf"')
    expect(localFilePathFromHref('https://example.com/file.apk')).toBeUndefined()
    expect(localFilePathFromHref('../outside.apk')).toBeUndefined()
  })
})
