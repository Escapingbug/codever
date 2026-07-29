import { createHash } from 'node:crypto'

export interface GatewayProjectIdentity {
    id: string
    name: string
    cwd: string
}

export function gatewayProjectIdentity(
    cwdInput: string,
    nameInput?: string,
): GatewayProjectIdentity {
    const cwd = cwdInput.trim()
    const normalized = normalizeProjectCwd(cwd)
    const name = nameInput?.trim() || projectNameFromCwd(normalized)
    const digest = createHash('sha256').update(normalized).digest('base64url').slice(0, 22)
    return {
        id: `project-${digest}`,
        name,
        cwd,
    }
}

export function normalizeProjectCwd(cwdInput: string): string {
    const trimmed = cwdInput.trim()
    if (!trimmed) throw new Error('Project working directory is required')
    const normalized = trimmed.replace(/\\/g, '/')
    if (normalized === '/') return normalized
    if (/^[A-Za-z]:\/$/u.test(normalized)) {
        return `${normalized[0]!.toUpperCase()}:`
    }
    return normalized.replace(/\/+$/u, '')
}

export function projectNameFromCwd(cwd: string): string {
    if (cwd === '/') return '/'
    if (/^[A-Za-z]:$/u.test(cwd)) return cwd
    return cwd.split('/').filter(Boolean).at(-1) ?? cwd
}
