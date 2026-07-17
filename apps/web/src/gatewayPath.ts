import type { GatewayPlatform } from '@codever/protocol'

export function gatewayPathPlaceholder(platform: GatewayPlatform | undefined): string {
  switch (platform) {
    case 'windows': return 'D:\\work\\project'
    case 'macos': return '/Users/name/project'
    case 'container': return '/workspace/project'
    default: return '/srv/project'
  }
}

export function gatewayPathHelp(platform: GatewayPlatform | undefined): string {
  switch (platform) {
    case 'windows': return 'Use an absolute Windows path visible to the Gateway, such as D:\\work\\project or a UNC path.'
    case 'macos': return 'Use an absolute macOS path visible to the Gateway, such as /Users/name/project.'
    case 'container': return 'This Gateway runs in a container. Use the path inside the container, not the host machine path.'
    case 'linux': return 'Use an absolute Linux path visible to the Gateway, such as /srv/project.'
    default: return 'Use an absolute path visible to the Gateway process.'
  }
}

export function validateGatewayPath(path: string, platform: GatewayPlatform | undefined): string | undefined {
  const value = path.trim()
  if (!value) return 'Project path is required.'
  if (platform === 'windows') {
    if (/^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value)) return undefined
    return 'Enter an absolute Windows path, such as D:\\work\\project.'
  }
  if (platform === 'linux' || platform === 'macos' || platform === 'container') {
    if (value.startsWith('/')) return undefined
    const namespace = platform === 'container' ? 'container' : platform
    return `This Gateway uses a ${namespace} filesystem. Enter a path beginning with /.`
  }
  return undefined
}
