import { describe, expect, it, vi } from 'vitest'
import { LlamaHasAdapter } from './hasAdapter.js'

function completion(content: string): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content } }],
    }), { status: 200 })) as typeof fetch
}

describe('LlamaHasAdapter', () => {
    it('accepts only loopback inference endpoints', () => {
        expect(() => new LlamaHasAdapter({
            endpoint: 'https://has.example/v1/chat/completions',
            model: 'HaS',
            modelRevision: 'digest-1',
        })).toThrow('loopback')
    })

    it('parses HaS mapping output and emits stable readable pseudonyms', async () => {
        const fetchImpl = completion(JSON.stringify({
            个人姓名: ['张三'],
            电子邮箱: ['zhangsan@example.com'],
        }))
        const adapter = new LlamaHasAdapter({
            model: 'HaS',
            modelRevision: 'digest-1',
            fetch: fetchImpl,
        })
        const first = await adapter.hide({
            text: '张三的邮箱是 zhangsan@example.com',
            entityTypes: ['个人姓名', '电子邮箱'],
            mapping: {},
        })

        expect(first.anonymizedText).toBe('李四的邮箱是 contact001@example.cn')
        expect(first.mappingDelta).toEqual({
            'contact001@example.cn': ['zhangsan@example.com'],
            李四: ['张三'],
        })
        const second = await adapter.hide({
            text: '再次联系张三',
            entityTypes: ['个人姓名'],
            mapping: first.mappingDelta,
        })
        expect(second.anonymizedText).toBe('再次联系李四')
        expect(second.mappingDelta).toEqual({})
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('fails closed on malformed model output and protected business amounts', async () => {
        const invalid = new LlamaHasAdapter({
            model: 'HaS',
            modelRevision: 'digest-1',
            fetch: completion('I found something private'),
        })
        await expect(invalid.hide({
            text: '张三',
            entityTypes: ['个人姓名'],
            mapping: {},
        })).rejects.toThrow('unrecognizable')

        const amount = new LlamaHasAdapter({
            model: 'HaS',
            modelRevision: 'digest-1',
            fetch: completion(JSON.stringify({ 工资金额: ['1000元'] })),
        })
        await expect(amount.hide({
            text: '工资是1000元',
            entityTypes: ['个人姓名'],
            mapping: {},
        })).rejects.toThrow('protected business amount')
    })

    it('accepts a valid empty mapping as no findings', async () => {
        const adapter = new LlamaHasAdapter({
            model: 'HaS',
            modelRevision: 'digest-1',
            fetch: completion('{}'),
        })
        await expect(adapter.hide({
            text: '这是一段普通文本',
            entityTypes: ['个人姓名'],
            mapping: {},
        })).resolves.toMatchObject({
            anonymizedText: '这是一段普通文本',
            mappingDelta: {},
        })
    })
})
