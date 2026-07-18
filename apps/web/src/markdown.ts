import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

const defaultValidateLink = markdown.validateLink.bind(markdown)
markdown.validateLink = href => Boolean(localFilePathFromHref(href)) || defaultValidateLink(href)

const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index]!
  const href = token.attrGet('href') ?? ''
  const localPath = localFilePathFromHref(href)
  if (localPath) {
    token.attrSet('href', '#')
    token.attrSet('data-codever-local-file', localPath)
  } else {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, environment, self)
    : self.renderToken(tokens, index, options)
}

export function localFilePathFromHref(href: string): string | undefined {
  let value = href.trim()
  try { value = decodeURIComponent(value) } catch { /* Keep the original invalid escape for rejection. */ }
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      value = decodeURIComponent(url.pathname)
    } catch { return undefined }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1)
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replaceAll('\\', '/')
  if (value.startsWith('/') && !value.startsWith('//')) return value
  return undefined
}

export function renderMarkdown(source: string): string {
  return markdown.render(source)
}
