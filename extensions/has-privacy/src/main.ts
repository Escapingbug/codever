import { resolve } from 'node:path'
import { PrivacyAuditLog } from './audit.js'
import { LlamaHasAdapter } from './hasAdapter.js'
import { createHasExtensionServer } from './server.js'
import { HasSessionExtensionService } from './service.js'
import { EncryptedMappingVault } from './vault.js'

const port = networkPort(process.env.HAS_EXTENSION_PORT ?? '8791')
const bearerToken = requiredEnvironment('HAS_EXTENSION_TOKEN')
const vaultKey = Buffer.from(requiredEnvironment('HAS_PRIVACY_VAULT_KEY'), 'base64')
if (vaultKey.byteLength !== 32) {
    throw new Error('HAS_PRIVACY_VAULT_KEY must be a base64-encoded 32-byte key')
}
const stateDirectory = resolve(
    process.env.HAS_PRIVACY_STATE_DIR ?? '.runtime/has-session-extension',
)
const model = process.env.HAS_MODEL ?? 'xuanwulab/HaS_Text_0209_0.6B_Q8'
const modelRevision = requiredEnvironment('HAS_MODEL_REVISION')
const adapter = new LlamaHasAdapter({
    endpoint: process.env.HAS_ENDPOINT,
    model,
    modelRevision,
    timeoutMs: process.env.HAS_TIMEOUT_MS
        ? positiveInteger(process.env.HAS_TIMEOUT_MS, 'HAS_TIMEOUT_MS')
        : undefined,
})
const vault = await EncryptedMappingVault.open(
    resolve(stateDirectory, 'mapping-vault.json'),
    vaultKey,
)
const service = new HasSessionExtensionService({
    adapter,
    vault,
    audit: new PrivacyAuditLog(
        resolve(stateDirectory, 'privacy-audit.jsonl'),
        vaultKey,
    ),
})
const server = createHasExtensionServer({
    service,
    bearerToken,
    modelIdentity: adapter.identity,
    onLog: message => process.stderr.write(`${message}\n`),
})

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`HaS session extension: http://127.0.0.1:${port}\n`)
    process.stdout.write(`HaS inference: ${process.env.HAS_ENDPOINT ?? 'http://127.0.0.1:18080/v1/chat/completions'}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)))
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]
    if (!value?.trim()) throw new Error(`${name} is required`)
    return value
}

function positiveInteger(value: string, name: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`)
    return parsed
}

function networkPort(value: string): number {
    const parsed = positiveInteger(value, 'HAS_EXTENSION_PORT')
    if (parsed > 65_535) throw new Error('HAS_EXTENSION_PORT must not exceed 65535')
    return parsed
}
