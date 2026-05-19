import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDaemonBaseDir } from '@/config'
import type { RichUserInput } from '@/runtime/semantic'

const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024

interface TelegramFileApi {
    getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>
}

interface TelegramUploadMessage {
    text?: string
    caption?: string
    photo?: Array<{ file_id: string; file_size?: number }>
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
    audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
    voice?: { file_id: string; mime_type?: string; file_size?: number }
}

export interface BuildRichInputOptions {
    api: TelegramFileApi
    botToken: string
    topicKey: string
    message: TelegramUploadMessage
}

export async function buildRichInputFromTelegramMessage(options: BuildRichInputOptions): Promise<{ text: string; richInput: RichUserInput }> {
    const { message } = options
    const text = typeof message.text === 'string'
        ? message.text
        : typeof message.caption === 'string'
            ? message.caption
            : ''
    const parts: RichUserInput['parts'] = []
    if (text.trim().length > 0) parts.push({ type: 'text', text })

    if (message.photo?.length) {
        const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1)!
        const download = await downloadTelegramFile(options.api, options.botToken, photo.file_id, MAX_MEDIA_BYTES)
        parts.push({
            type: 'image',
            mimeType: 'image/jpeg',
            data: download.buffer.toString('base64'),
            source: `telegram:${photo.file_id}`,
            filename: filenameFromTelegramPath(download.telegramPath, 'photo.jpg'),
            sizeBytes: download.sizeBytes,
        })
    } else if (message.voice) {
        const download = await downloadTelegramFile(options.api, options.botToken, message.voice.file_id, MAX_MEDIA_BYTES)
        parts.push({
            type: 'audio',
            mimeType: message.voice.mime_type || 'audio/ogg',
            data: download.buffer.toString('base64'),
            source: `telegram:${message.voice.file_id}`,
            filename: filenameFromTelegramPath(download.telegramPath, 'voice.ogg'),
            sizeBytes: download.sizeBytes,
        })
    } else if (message.audio) {
        const download = await downloadTelegramFile(options.api, options.botToken, message.audio.file_id, MAX_MEDIA_BYTES)
        parts.push({
            type: 'audio',
            mimeType: message.audio.mime_type || 'audio/mpeg',
            data: download.buffer.toString('base64'),
            source: `telegram:${message.audio.file_id}`,
            filename: sanitizeFilename(message.audio.file_name || filenameFromTelegramPath(download.telegramPath, 'audio')),
            sizeBytes: download.sizeBytes,
        })
    } else if (message.document) {
        const mimeType = message.document.mime_type || 'application/octet-stream'
        const isImage = mimeType.startsWith('image/')
        const isAudio = mimeType.startsWith('audio/')
        const download = await downloadTelegramFile(options.api, options.botToken, message.document.file_id, isImage || isAudio ? MAX_MEDIA_BYTES : MAX_FILE_BYTES)
        const filename = sanitizeFilename(message.document.file_name || filenameFromTelegramPath(download.telegramPath, 'upload'))
        if (isImage || isAudio) {
            parts.push({
                type: isImage ? 'image' : 'audio',
                mimeType,
                data: download.buffer.toString('base64'),
                source: `telegram:${message.document.file_id}`,
                filename,
                sizeBytes: download.sizeBytes,
            })
        } else {
            const path = await writeCachedUpload(options.topicKey, filename, download.buffer)
            parts.push({
                type: 'file',
                path,
                filename,
                mimeType,
                sizeBytes: download.sizeBytes,
                source: `telegram:${message.document.file_id}`,
            })
        }
    }

    return { text, richInput: { parts } }
}

async function downloadTelegramFile(api: TelegramFileApi, botToken: string, fileId: string, maxBytes: number): Promise<{ buffer: Buffer; telegramPath: string; sizeBytes: number }> {
    const file = await api.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram did not return a file path')
    if (file.file_size !== undefined && file.file_size > maxBytes) {
        throw new Error(`Telegram file is too large (${file.file_size} bytes, limit ${maxBytes})`)
    }

    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`)
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
        throw new Error(`Telegram file is too large (${buffer.byteLength} bytes, limit ${maxBytes})`)
    }
    return { buffer, telegramPath: file.file_path, sizeBytes: buffer.byteLength }
}

async function writeCachedUpload(topicKey: string, filename: string, buffer: Buffer): Promise<string> {
    const dir = join(getDaemonBaseDir(), 'uploads', sanitizePathSegment(topicKey))
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${Date.now()}-${randomUUID()}-${filename}`)
    await writeFile(target, buffer)
    return target
}

function filenameFromTelegramPath(path: string, fallback: string): string {
    return sanitizeFilename(basename(path) || fallback)
}

function sanitizeFilename(filename: string): string {
    const base = basename(filename).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
    return base || 'upload'
}

function sanitizePathSegment(segment: string): string {
    return segment.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'
}
