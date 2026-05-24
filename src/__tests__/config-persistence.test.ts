import { beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryConf<T extends Record<string, any>> {
    private data: T

    constructor(options: { defaults: T }) {
        this.data = structuredClone(options.defaults)
    }

    get<K extends keyof T>(key: K): T[K] {
        return this.data[key]
    }

    set<K extends keyof T>(key: K, value: T[K]): void {
        this.data[key] = value
    }
}

vi.mock('conf', () => ({
    default: MemoryConf,
}))

async function loadConfig() {
    vi.resetModules()
    return await import('@/config')
}

describe('config persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('persists conversation state only at topic level', async () => {
        const { config } = await loadConfig()

        config.saveTopicState('-100:main', { conversationId: 'topic-conversation', queryInProgress: true })

        expect(config.getTopicState('-100:main')).toEqual({
            conversationId: 'topic-conversation',
            queryInProgress: true,
        })
    })

    it('does not infer topic state from group state', async () => {
        const { config } = await loadConfig()

        config.saveGroupState(-200, { cwd: '/repo' })

        expect(config.getTopicState('-200:main')).toBeUndefined()
    })

    it('clears topic conversation without touching group settings', async () => {
        const { config } = await loadConfig()

        config.saveGroupState(-300, { cwd: '/repo', settings: { model: 'sonnet' } })
        config.saveTopicState('-300:42', {
            conversationId: 'topic-conversation',
            queryInProgress: true,
            settings: { providerName: 'opencode', model: 'opencode-model' },
        })
        config.clearTopicConversation('-300:42')

        expect(config.getTopicState('-300:42')).toEqual({
            queryInProgress: false,
            settings: { providerName: 'opencode', model: 'opencode-model' },
        })
        expect(config.getGroupState(-300)).toEqual({ cwd: '/repo', settings: { model: 'sonnet' } })
    })

    it('replaces group settings when saving settings state', async () => {
        const { config } = await loadConfig()

        config.saveGroupState(-400, { cwd: '/repo', settings: { model: 'opencode-model', providerName: 'opencode' } })
        config.saveGroupState(-400, { settings: { providerName: 'agent' } })

        expect(config.getGroupState(-400)).toEqual({ cwd: '/repo', settings: { providerName: 'agent' } })
    })
})
