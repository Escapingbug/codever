import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    MAX_CODEVER_ATTACHMENT_BYTES,
    MAX_CODEVER_PROMPT_ATTACHMENT_BYTES,
    type CodeverAttachment,
    type CommandPayload,
} from '@codever/protocol'
import { decryptMedia, sha256 } from '@codever/security'
import type { MatrixTransport } from '@/channel/matrix'
import type { RichUserInput, RichUserInputPart } from '@/runtime/semantic'

const MAX_ENCRYPTED_ATTACHMENT_BYTES = MAX_CODEVER_ATTACHMENT_BYTES + 16

type PromptPayload = Extract<CommandPayload, { operation: 'prompt' }>

export async function materializePromptInput(
    payload: PromptPayload,
    transport: MatrixTransport,
    cacheRoot: string,
): Promise<RichUserInput> {
    const parts: RichUserInputPart[] = payload.text.length > 0
        ? [{ type: 'text', text: payload.text }]
        : []
    let totalBytes = 0
    for (const attachment of payload.attachments ?? []) {
        totalBytes += attachment.size
        if (totalBytes > MAX_CODEVER_PROMPT_ATTACHMENT_BYTES) {
            throw new Error(
                `Prompt attachments exceed the ${MAX_CODEVER_PROMPT_ATTACHMENT_BYTES} byte combined limit`,
            )
        }
        parts.push(await materializeAttachment(attachment, transport, cacheRoot))
    }
    return { parts }
}

async function materializeAttachment(
    attachment: CodeverAttachment,
    transport: MatrixTransport,
    cacheRoot: string,
): Promise<RichUserInputPart> {
    if (attachment.media.size > MAX_ENCRYPTED_ATTACHMENT_BYTES) {
        throw new Error(`Encrypted attachment is too large: ${attachment.name}`)
    }
    const download = transport.downloadEncryptedMedia
    if (!download) {
        throw new Error('Matrix transport does not support encrypted media download')
    }
    const ciphertext = await download.call(transport, {
        url: attachment.media.url,
        maxBytes: attachment.media.size,
    })
    const plaintext = await decryptMedia(ciphertext, attachment.media)
    if (plaintext.byteLength !== attachment.size) {
        throw new Error(`Attachment size mismatch: ${attachment.name}`)
    }
    if (await sha256(plaintext) !== attachment.sha256) {
        throw new Error(`Attachment integrity check failed: ${attachment.name}`)
    }

    const source = `pwa-attachment:${attachment.id}`
    if (attachment.mimeType.startsWith('image/')) {
        return {
            type: 'image',
            mimeType: attachment.mimeType,
            data: Buffer.from(plaintext).toString('base64'),
            source,
            filename: attachment.name,
            sizeBytes: plaintext.byteLength,
        }
    }
    if (attachment.mimeType.startsWith('audio/')) {
        return {
            type: 'audio',
            mimeType: attachment.mimeType,
            data: Buffer.from(plaintext).toString('base64'),
            source,
            filename: attachment.name,
            sizeBytes: plaintext.byteLength,
        }
    }

    const path = await cacheFile(cacheRoot, attachment, plaintext)
    return {
        type: 'file',
        path,
        filename: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: plaintext.byteLength,
        source,
    }
}

async function cacheFile(
    cacheRoot: string,
    attachment: CodeverAttachment,
    plaintext: Uint8Array,
): Promise<string> {
    const directory = join(cacheRoot, attachment.sha256)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, safeFilename(attachment.name))
    try {
        await writeFile(path, plaintext, { flag: 'wx', mode: 0o600 })
    } catch (error) {
        if (!isAlreadyExists(error)) throw error
        const existing = new Uint8Array(await readFile(path))
        if (
            existing.byteLength !== plaintext.byteLength
            || await sha256(existing) !== attachment.sha256
        ) {
            throw new Error(`Cached attachment conflicts with ${attachment.name}`)
        }
    }
    return path
}

function safeFilename(value: string): string {
    const cleaned = value
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
        .replace(/^\.+/u, '')
        .trim()
        .slice(0, 180)
    return cleaned || 'attachment'
}

function isAlreadyExists(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'EEXIST',
    )
}
