import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '@/gateway/projects'
import { GatewaySessionService, FileSessionMetadataRepository } from '@/gateway/sessions'
import { toWireConversationEvent, type GatewayConversationEvent } from '@/gateway/runtime'
import { FileConversationEventStore } from '@/platform/storage'
import { ScriptedAgentProvider } from '../test/support/scriptedAgentProvider'

const cleanup: string[] = []

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('C04/C05 scripted Gateway journey', () => {
    it('records the correlated user message before streaming Agent output and completion', async () => {
        const fixture = await createFixture()
        const provider = new ScriptedAgentProvider()
        const service = await GatewaySessionService.open({
            gatewayId: 'gateway-e2e',
            projects: fixture.projects,
            repository: fixture.repository,
            eventStore: fixture.events,
            providerFactory: () => provider,
            providerDiscoveryFactory: () => provider,
        })
        const session = await service.create(fixture.project.id, {
            provider: provider.name,
            title: 'Business journey',
            config: {},
        })
        const live: GatewayConversationEvent[] = []
        service.subscribe(envelope => live.push(envelope.event))

        const result = service.sendMessage(session.id, 'Build the APK', 'command-1', 'client-message-1')
        const turn = await provider.nextTurn()

        expect(live[0]).toMatchObject({
            kind: 'user_message',
            clientMessageId: 'client-message-1',
            input: 'Build the APK',
        })
        expect(live.some(event => event.kind === 'assistant_text_delta')).toBe(false)

        turn.emit({ kind: 'text', text: 'Building ' })
        turn.emit({ kind: 'text', text: 'complete.' })
        await eventually(() => live.filter(event => event.kind === 'assistant_text_delta').length === 2)
        expect(live.filter(event => event.kind === 'assistant_text_delta')).toHaveLength(2)
        turn.finish('success')

        await expect(result).resolves.toMatchObject({ status: 'success' })
        expect(live.at(-1)).toMatchObject({ kind: 'state', state: 'idle' })

        const stored = await fixture.events.list(session.id)
        const wire = stored.events.flatMap(envelope => {
            const event = toWireConversationEvent(envelope.event)
            return event ? [event] : []
        })
        expect(wire.find(event => event.kind === 'user_message')).toMatchObject({
            clientMessageId: 'client-message-1',
        })
        expect(wire.filter(event => event.kind === 'assistant_text_delta').map(event =>
            event.kind === 'assistant_text_delta' ? event.text : '')).toEqual(['Building ', 'complete.'])

        await service.destroy()
        await fixture.events.close()
    })
})

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'codever-scripted-e2e-'))
    cleanup.push(directory)
    const root = join(directory, 'project')
    await mkdir(root, { recursive: true })
    const projects = await ProjectRegistry.open({ storagePath: join(directory, 'projects.json') })
    const project = await projects.create({ name: 'Project', rootPath: root })
    const repository = await FileSessionMetadataRepository.open(join(directory, 'sessions.json'))
    const events = new FileConversationEventStore<GatewayConversationEvent>(join(directory, 'events.jsonl'))
    return { directory, root, projects, project, repository, events }
}

async function eventually(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (assertion()) return
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for scripted Gateway state')
}
