import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrivacyAuditLog } from './audit.js'
import { DeterministicHasAdapter } from './hasAdapter.js'
import { createHasExtensionServer } from './server.js'
import { HasSessionExtensionService } from './service.js'
import { EncryptedMappingVault } from './vault.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path =>
        rm(path, { recursive: true, force: true })))
})

async function fixture(entities: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), 'codever-has-extension-'))
    temporaryDirectories.push(directory)
    const vaultPath = join(directory, 'mapping-vault.json')
    const auditPath = join(directory, 'privacy-audit.jsonl')
    const vaultKey = randomBytes(32)
    const vault = await EncryptedMappingVault.open(vaultPath, vaultKey)
    const adapter = new DeterministicHasAdapter(entities)
    const service = new HasSessionExtensionService({
        adapter,
        vault,
        audit: new PrivacyAuditLog(auditPath, vaultKey),
    })
    return { service, adapter, vault, vaultKey, vaultPath, auditPath }
}

const session = {
    sessionId: 'session-1',
    cwd: '/workspace',
    providerName: 'codex',
}
const turn = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    providerName: 'codex',
}
const binding = {
    id: 'has-privacy',
    config: { contextId: 'metapp-payroll-1', reviewRequired: true },
}

function event(kind: string, fields: Record<string, unknown> = {}) {
    return {
        kind,
        meta: {
            id: `event-${kind}`,
            sessionId: session.sessionId,
            turnId: turn.turnId,
            provider: 'codex',
            seq: 1,
            timestamp: 1,
            sourcePhase: 'live',
        },
        ...fields,
    }
}

describe('HaS session extension', () => {
    it('previews exact outbound text, commits encrypted mapping, and restores split output', async () => {
        const { service, vaultPath, auditPath } = await fixture({
            张三: '李四',
            'zhangsan@example.com': 'contact001@example.cn',
        })
        const prepared = await service.prepare({
            session,
            turn,
            binding,
            input: '请总结张三（zhangsan@example.com）的记录',
        })

        expect(prepared).toMatchObject({
            kind: 'approval_required',
            approval: {
                details: expect.stringContaining('请总结李四（contact001@example.cn）的记录'),
            },
        })
        const committed = await service.commit({
            session,
            turn,
            preparationToken: prepared.preparationToken,
        })
        expect(committed).toMatchObject({
            kind: 'ready',
            input: '请总结李四（contact001@example.cn）的记录',
        })

        const stateRef = String(committed.stateRef)
        const displayed: string[] = []
        for (const text of ['李', '四的邮箱是contact001@', 'example.cn']) {
            const result = await service.present({
                session,
                turn,
                stateRef,
                event: event('assistant_text_delta', { text }),
            }) as { events: Array<{ text?: string }> }
            displayed.push(...result.events.flatMap(item => item.text ?? []))
        }
        const finished = await service.present({
            session,
            turn,
            stateRef,
            event: event('turn_finished', { status: 'success' }),
        }) as { events: Array<{ kind: string; text?: string; status?: string }> }
        displayed.push(...finished.events.flatMap(item => item.text ?? []))
        expect(displayed.join('')).toBe('张三的邮箱是zhangsan@example.com')
        expect(finished.events.at(-1)).toMatchObject({
            kind: 'turn_finished',
            status: 'success',
        })

        const vaultSource = await readFile(vaultPath, 'utf8')
        expect(vaultSource).not.toContain('张三')
        expect(vaultSource).not.toContain('zhangsan@example.com')
        const auditSource = await readFile(auditPath, 'utf8')
        expect(auditSource).not.toContain('张三')
        expect(auditSource).not.toContain('zhangsan@example.com')
        expect(auditSource).toContain('"action":"commit"')
    })

    it('keeps ordinary data out of the provider when review is denied', async () => {
        const { service } = await fixture({ 张三: '李四' })
        const prepared = await service.prepare({ session, turn, binding, input: '张三' })
        await expect(service.reject({
            session,
            turn,
            preparationToken: prepared.preparationToken,
        })).resolves.toEqual({ rejected: true })
        await expect(service.commit({
            session,
            turn,
            preparationToken: prepared.preparationToken,
        })).rejects.toThrow('missing or expired')
    })

    it('rejects non-text input instead of bypassing privacy', async () => {
        const { service } = await fixture({ 张三: '李四' })
        await expect(service.prepare({
            session,
            turn,
            binding,
            input: {
                parts: [{
                    type: 'file',
                    path: '/private/payroll.xlsx',
                    filename: 'payroll.xlsx',
                }],
            },
        })).rejects.toThrow('text-only')
    })

    it('rejects the second of two concurrent previews after mapping CAS advances', async () => {
        const { service } = await fixture({ 张三: '李四', 王五: '赵六' })
        const first = await service.prepare({
            session,
            turn: { ...turn, turnId: 'turn-a' },
            binding,
            input: '张三',
        })
        const second = await service.prepare({
            session,
            turn: { ...turn, turnId: 'turn-b' },
            binding,
            input: '王五',
        })
        await service.commit({
            session,
            turn: { ...turn, turnId: 'turn-a' },
            preparationToken: first.preparationToken,
        })
        await expect(service.commit({
            session,
            turn: { ...turn, turnId: 'turn-b' },
            preparationToken: second.preparationToken,
        })).rejects.toThrow('mapping changed')
    })

    it('supports automatic commit only when the immutable binding opts out of review', async () => {
        const { service } = await fixture({ 张三: '李四' })
        await expect(service.prepare({
            session,
            turn,
            binding: {
                ...binding,
                config: { ...binding.config, reviewRequired: false },
            },
            input: '张三',
        })).resolves.toMatchObject({ kind: 'ready', input: '李四' })
    })

    it('serves the protocol on loopback with bearer authentication', async () => {
        const { service, adapter } = await fixture({ 张三: '李四' })
        const server = createHasExtensionServer({
            service,
            bearerToken: 'extension-secret-at-least-32-bytes',
            modelIdentity: adapter.identity,
        })
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })
        try {
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('server address missing')
            const base = `http://127.0.0.1:${address.port}`
            await expect(fetch(`${base}/health`).then(response => response.json()))
                .resolves.toMatchObject({ status: 'ok', extension: { id: 'has-privacy' } })
            await expect(fetch(`${base}/v1/turns/prepare`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ session, turn, binding, input: '张三' }),
            }).then(response => response.status)).resolves.toBe(401)
            const response = await fetch(`${base}/v1/turns/prepare`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer extension-secret-at-least-32-bytes',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ session, turn, binding, input: '张三' }),
            })
            expect(response.status).toBe(200)
            await expect(response.json()).resolves.toMatchObject({
                kind: 'approval_required',
                approval: { details: expect.stringContaining('李四') },
            })
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close(error => error ? reject(error) : resolve()))
        }
    })

    it('fails closed when the durable mapping key is unavailable', async () => {
        const { service, vaultPath } = await fixture({ 张三: '李四' })
        const prepared = await service.prepare({ session, turn, binding, input: '张三' })
        await service.commit({
            session,
            turn,
            preparationToken: prepared.preparationToken,
        })

        const wrongKeyVault = await EncryptedMappingVault.open(vaultPath, randomBytes(32))
        await expect(wrongKeyVault.current('metapp-payroll-1'))
            .rejects.toThrow('authentication failed')
    })

    it('binds display state to the exact session turn and provider', async () => {
        const { service } = await fixture({ 张三: '李四' })
        const prepared = await service.prepare({ session, turn, binding, input: '张三' })
        const committed = await service.commit({
            session,
            turn,
            preparationToken: prepared.preparationToken,
        })

        await expect(service.present({
            session,
            turn: { ...turn, turnId: 'different-turn' },
            stateRef: committed.stateRef,
            event: event('assistant_text_delta', { text: '李四' }),
        })).rejects.toThrow('scope mismatch')
        await expect(service.present({
            session: { ...session, providerName: 'different-provider' },
            turn: { ...turn, providerName: 'different-provider' },
            stateRef: committed.stateRef,
            event: event('assistant_text_delta', { text: '李四' }),
        })).rejects.toThrow('scope mismatch')
    })
})
