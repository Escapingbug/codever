/**
 * tgmdrender — Node.js wrapper for the Python tgmdrender CLI.
 *
 * Calls tgmdrender.py to convert Markdown into Telegram-compatible
 * entity-based format (text + MessageEntity pairs) and table PNG images.
 */

import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

// Resolve the Python script path.
// In development, import.meta.url points to src/utils/tgmdrender.ts
// In production (tsup bundle), it points to dist/daemon.js
// We try multiple candidate paths and use the first one that exists.
function findTgmdrenderScript(): string {
    // Strategy 1: relative to process.cwd() (daemon runs from project root)
    const cwdCandidate = resolve(process.cwd(), 'scripts/tgmdrender.py')
    if (existsSync(cwdCandidate)) return cwdCandidate

    // Strategy 2: relative to this file (works in dev, not in bundle)
    try {
        const { dirname } = require('node:path')
        const { fileURLToPath } = require('node:url')
        const __dirname = dirname(fileURLToPath(import.meta.url))
        const fileCandidate = resolve(__dirname, '../../scripts/tgmdrender.py')
        if (existsSync(fileCandidate)) return fileCandidate
    } catch {}

    // Fallback: assume cwd
    return cwdCandidate
}

const TGMDRENDER_PY = findTgmdrenderScript()

/** A single Telegram MessageEntity as returned by tgmdrender */
export interface TgEntity {
    type: string
    offset: number
    length: number
    url?: string
    language?: string
}

/** A segment returned by tgmdrender convert/split */
export interface TgmdSegment {
    kind: 'text' | 'table'
    text?: string
    entities?: TgEntity[]
    markdown?: string
}

/** Result of tgmdrender availability check */
export interface TgmdStatus {
    available: boolean
    error?: string
}

// ---------- Availability check ----------

let _status: TgmdStatus | null = null

/**
 * Check if tgmdrender is available (Python + dependencies installed).
 * Result is cached after first check.
 */
export function checkTgmdrender(): TgmdStatus {
    if (_status) return _status
    try {
        // Test with empty input using convert --no-split
        const result = spawnSyncChecked(['convert', '--no-split'], '', 5000)
        if (result.exitCode === 0) {
            _status = { available: true }
        } else {
            _status = { available: false, error: result.stderr || 'tgmdrender check failed' }
        }
    } catch (e) {
        _status = { available: false, error: e instanceof Error ? e.message : String(e) }
    }
    return _status
}

/**
 * Reset cached availability status (e.g., after installing deps).
 */
export function resetTgmdStatus(): void {
    _status = null
}

// ---------- Core spawn helpers ----------

interface SpawnResult {
    exitCode: number
    stdout: string
    stderr: string
}

function spawnSyncChecked(args: string[], input: string, timeoutMs: number): SpawnResult {
    const result = spawnSync('python', [TGMDRENDER_PY, ...args], {
        input,
        timeout: timeoutMs,
        encoding: 'utf-8',
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    }
}

function spawnAsync(args: string[], input: string, timeoutMs: number): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('python', [TGMDRENDER_PY, ...args], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d))
        child.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
        if (input) {
            child.stdin.write(input)
            child.stdin.end()
        }
        child.on('close', (code) => {
            resolve({
                exitCode: code ?? 1,
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: Buffer.concat(stderrChunks).toString('utf-8'),
            })
        })
        child.on('error', reject)
        setTimeout(() => {
            child.kill()
            reject(new Error(`tgmdrender ${args.join(' ')} timed out after ${timeoutMs}ms`))
        }, timeoutMs).unref()
    })
}

// ---------- Public API ----------

/**
 * Convert markdown to text + entity segments (with table detection).
 * Uses tgmdrender convert subcommand.
 */
export async function tgmdConvert(markdown: string, options?: { noSplit?: boolean }): Promise<TgmdSegment[]> {
    const args = ['convert']
    if (options?.noSplit) args.push('--no-split')
    const result = await spawnAsync(args, markdown, 15_000)
    if (result.exitCode !== 0) {
        throw new Error(`tgmdrender convert failed: ${result.stderr}`)
    }
    return JSON.parse(result.stdout) as TgmdSegment[]
}

/**
 * Convert markdown and split into Telegram UTF-16 sized chunks.
 * Uses tgmdrender split subcommand.
 */
export async function tgmdSplit(markdown: string, maxUtf16: number = 4000): Promise<TgmdSegment[]> {
    const result = await spawnAsync(['split', '--max-utf16', String(maxUtf16)], markdown, 15_000)
    if (result.exitCode !== 0) {
        throw new Error(`tgmdrender split failed: ${result.stderr}`)
    }
    return JSON.parse(result.stdout) as TgmdSegment[]
}

/**
 * Render a markdown table as a PNG image buffer.
 * Uses tgmdrender table subcommand.
 */
export async function tgmdTableImage(markdown: string, theme: string = 'github-dark'): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('python', [TGMDRENDER_PY, 'table', '--theme', theme], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
        const chunks: Buffer[] = []
        const errChunks: Buffer[] = []
        child.stdout.on('data', (d: Buffer) => chunks.push(d))
        child.stderr.on('data', (d: Buffer) => errChunks.push(d))
        child.stdin.write(markdown)
        child.stdin.end()
        child.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(chunks))
            } else {
                reject(new Error(`tgmdrender table failed: ${Buffer.concat(errChunks).toString('utf-8')}`))
            }
        })
        child.on('error', reject)
        setTimeout(() => {
            child.kill()
            reject(new Error('tgmdrender table timed out'))
        }, 30_000).unref()
    })
}

/**
 * Synchronous convert for simple cases (e.g., quick formatting).
 */
export function tgmdConvertSync(markdown: string, options?: { noSplit?: boolean }): TgmdSegment[] {
    const args = ['convert']
    if (options?.noSplit) args.push('--no-split')
    const result = spawnSyncChecked(args, markdown, 10_000)
    if (result.exitCode !== 0) {
        throw new Error(`tgmdrender convert failed: ${result.stderr}`)
    }
    return JSON.parse(result.stdout) as TgmdSegment[]
}
