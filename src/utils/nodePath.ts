import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { readFileSync, existsSync, accessSync, constants, openSync, readSync, closeSync } from 'node:fs'

export function getCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const cwd = process.cwd()
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const actualPathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH'

    if (env[actualPathKey]) {
        env[actualPathKey] = env[actualPathKey]!
            .split(pathSep)
            .filter(p => {
                const normalizedP = p.replace(/\\/g, '/').toLowerCase()
                const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
                return !normalizedP.startsWith(normalizedCwd)
            })
            .join(pathSep)
    }

    return env
}

/**
 * Resolve the absolute path to the current Node.js binary.
 * Works regardless of how Node was installed (asdf, nvm, volta, system pkg, etc.)
 */
export function resolveNodePath(): string {
    return process.execPath
}

/**
 * Check if a file is a shell script (text file with shebang) vs a native binary.
 * Returns true for shell scripts / shims that need a shell to execute.
 */
export function isShellScript(filePath: string): boolean {
    try {
        if (!existsSync(filePath)) return false
        // Read first 256 bytes to check for shebang
        const fd = openSync(filePath, 'r')
        const buf = Buffer.alloc(256)
        const bytesRead = readSync(fd, buf, 0, 256, 0)
        closeSync(fd)
        if (bytesRead < 2) return false
        // Native binaries start with ELF magic (\x7fELF) or Mach-O magic
        if (buf[0] === 0x7f && buf[1] === 0x45) return false // ELF
        if (buf[0] === 0xfe && buf[1] === 0xed) return false // Mach-O
        if (buf[0] === 0xcf && buf[1] === 0xfa) return false // Mach-O 64
        if (buf[0] === 0xca && buf[1] === 0xfe) return false // Mach-O universal
        // Check for shebang (#!)
        const header = buf.toString('utf8', 0, bytesRead)
        return header.startsWith('#!')
    } catch {
        return false
    }
}

/**
 * Detect if a path points to an asdf/mise/version-manager shim script
 * and resolve the real executable.
 * 
 * Handles multiple shim patterns:
 * - asdf:  exec /home/user/.asdf/installs/.../bin/cmd "$@"
 * - mise:  exec /home/user/.local/share/mise/installs/.../bin/cmd "$@"
 * - nvm:   direct symlinks (handled by realpath, not this function)
 * - Generic: any script with 'exec <absolute-path>' pattern
 */
function resolveShimScript(shimPath: string): string | null {
    try {
        if (!existsSync(shimPath)) return null
        if (!isShellScript(shimPath)) return null

        const content = readFileSync(shimPath, 'utf8')
        const lines = content.split('\n')

        for (const line of lines) {
            // Match: exec /absolute/path/to/binary ["$@" or $@]
            const execMatch = line.match(/^\s*exec\s+(?:")?(\/[^\s"$]+)/)
            if (execMatch) {
                const realPath = execMatch[1]
                if (realPath && existsSync(realPath)) {
                    logDebug(`[shim] Resolved ${shimPath} -> ${realPath}`)
                    return realPath
                }
            }
        }
    } catch {
        // Silently ignore errors reading shim file
    }
    return null
}

/**
 * Find a working shell path on this system.
 * Returns a specific shell path, or null if none found.
 * This avoids relying on Node's default /bin/sh which may not exist.
 */
export function findShellPath(): string | null {
    // Check common shell locations in order of preference
    const candidates = [
        process.env.SHELL,     // User's preferred shell
        '/bin/sh',
        '/usr/bin/sh',
        '/bin/bash',
        '/usr/bin/bash',
        '/usr/local/bin/bash',
        '/bin/dash',
        '/usr/bin/dash',
        '/bin/ash',            // Alpine Linux / BusyBox
        '/usr/bin/ash',
    ].filter(Boolean) as string[]

    for (const candidate of candidates) {
        try {
            if (existsSync(candidate)) {
                accessSync(candidate, constants.X_OK)
                logDebug(`[shell] Found shell at ${candidate}`)
                return candidate
            }
        } catch {
            // Not executable, try next
        }
    }

    logDebug('[shell] No shell found on system')
    return null
}

/** Cached result of findShellPath() — computed once per process. */
let _cachedShellPath: string | null | undefined

/**
 * Determine the spawn options for executing a command.
 * Returns { shell } option suitable for child_process.spawn.
 * - If command is a native binary: shell = false (direct exec, most reliable)
 * - If command is a shell script and we can find a shell: shell = '/path/to/shell'
 * - If command is a shell script and no shell exists: shell = false (try direct exec as fallback)
 */
export function getSpawnShellOption(commandPath: string): false | string {
    // Bare command names (e.g. 'claude') — let Node resolve via PATH, no shell needed
    if (!commandPath.includes('/') && !commandPath.includes('\\')) {
        return false
    }

    // If it's a native binary, no shell needed
    if (!isShellScript(commandPath)) {
        logDebug(`[spawn] ${commandPath} is a native binary, spawning directly`)
        return false
    }

    // It's a shell script — we need a shell to interpret it
    if (_cachedShellPath === undefined) {
        _cachedShellPath = findShellPath()
    }

    if (_cachedShellPath) {
        logDebug(`[spawn] ${commandPath} is a script, using shell ${_cachedShellPath}`)
        return _cachedShellPath
    }

    // No shell available — attempt direct exec (will work if script has valid shebang
    // and the interpreter exists, which is the OS's job)
    logDebug(`[spawn] ${commandPath} is a script but no shell found, trying direct exec`)
    return false
}

/**
 * Enhanced path resolution with multiple strategies:
 * 1. Check env var override (CODEVER_CLAUDE_PATH)
 * 2. Try 'which' to get full path from PATH
 * 3. If which returns a shim, resolve to real binary
 * 4. Fall back to bare command name (will use PATH at spawn time)
 */
export function getDefaultClaudeCodePath(): string {
    // Allow explicit override via env var (used by daemon)
    if (process.env.CODEVER_CLAUDE_PATH) {
        return process.env.CODEVER_CLAUDE_PATH
    }

    // Strategy 1: Use 'which'/'where' to resolve from PATH
    try {
        const whichCmd = process.platform === 'win32' ? 'where claude' : 'which claude'
        const whichPath = execSync(whichCmd, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim().split('\n')[0].trim() // 'where' on Windows may return multiple lines

        if (!whichPath) return 'claude'

        // Strategy 2: Check if it's a shim and resolve to real binary
        const realPath = resolveShimScript(whichPath)
        if (realPath) return realPath

        // Return the which result (might be shim or direct binary)
        return whichPath
    } catch {
        // 'which' failed — fall back to bare command name
        logDebug('[claude] which failed, using command name "claude"')
    }
    return 'claude'
}

/**
 * Ensure that the directories containing node and claude are on PATH.
 * Called early in daemon startup to fix shebang resolution.
 */
export function ensureDaemonPath(): void {
    const sep = process.platform === 'win32' ? ';' : ':'
    const dirs = new Set<string>()

    // Node binary dir
    const nodePath = process.env.CODEVER_NODE_PATH || process.execPath
    dirs.add(dirname(nodePath))

    // Claude binary dir
    const claudePath = process.env.CODEVER_CLAUDE_PATH
    if (claudePath) dirs.add(dirname(claudePath))

    const currentPath = process.env.PATH || ''
    const newDirs = [...dirs].filter(d => !currentPath.split(sep).includes(d))
    if (newDirs.length > 0) {
        process.env.PATH = [...newDirs, currentPath].join(sep)
    }
}

export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        console.log('[debug]', message)
    }
}

export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}
