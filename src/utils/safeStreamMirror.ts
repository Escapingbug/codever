type StreamChunk = string | Uint8Array
type StreamWrite = (chunk: StreamChunk, ...args: any[]) => unknown

const BROKEN_STREAM_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED'])

export interface SafeStreamMirror {
    write(chunk: StreamChunk, ...args: any[]): void
    isEnabled(): boolean
}

export function createSafeStreamMirror(write: StreamWrite): SafeStreamMirror {
    let enabled = true

    return {
        write(chunk: StreamChunk, ...args: any[]): void {
            if (!enabled) return
            try {
                write(chunk, ...args)
            } catch (error) {
                if (isBrokenStreamError(error)) {
                    enabled = false
                    return
                }
                throw error
            }
        },
        isEnabled(): boolean {
            return enabled
        },
    }
}

function isBrokenStreamError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && BROKEN_STREAM_CODES.has(code)
}
