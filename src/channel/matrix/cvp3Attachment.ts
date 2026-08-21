import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  MAX_CODEVER_ATTACHMENT_BYTES,
  attachmentSchema,
  type CodeverAttachment,
} from '@codever/protocol'
import { encryptMedia, sha256 } from '@codever/security'
import type { MatrixTransport } from './transport'

export interface Cvp3AttachmentInput {
  path: string
  filename?: string
}

/** Uploads one encrypted Matrix media object and returns its signed CVP descriptor. */
export async function uploadCvp3Attachment(
  transport: MatrixTransport,
  input: Cvp3AttachmentInput,
): Promise<CodeverAttachment> {
  const uploadMedia = transport.uploadEncryptedMedia
  if (!uploadMedia) throw new Error('Matrix transport does not support encrypted media upload')
  const metadata = await stat(input.path)
  if (!metadata.isFile()) throw new Error(`Attachment is not a regular file: ${input.path}`)
  if (metadata.size > MAX_CODEVER_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds the ${MAX_CODEVER_ATTACHMENT_BYTES} byte limit`)
  }
  const plaintext = new Uint8Array(await readFile(input.path))
  const encrypted = await encryptMedia(plaintext)
  const uploaded = await uploadMedia.call(transport, {
    ciphertext: encrypted.ciphertext,
  })
  return attachmentSchema.parse({
    id: randomUUID(),
    name: input.filename ?? input.path.split(/[\\/]/u).at(-1) ?? 'attachment',
    mimeType: attachmentMimeType(input.filename ?? input.path),
    size: plaintext.byteLength,
    sha256: await sha256(plaintext),
    media: { url: uploaded.url, ...encrypted.descriptor },
  })
}

function attachmentMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json'
    case '.md':
    case '.markdown': return 'text/markdown'
    case '.txt':
    case '.log': return 'text/plain'
    case '.csv': return 'text/csv'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.mp4': return 'video/mp4'
    case '.zip': return 'application/zip'
    default: return 'application/octet-stream'
  }
}
