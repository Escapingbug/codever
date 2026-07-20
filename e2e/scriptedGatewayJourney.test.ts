import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '@/gateway/projects'
import { GatewaySessionService, FileSessionMetadataRepository } from '@/gateway/sessions'
import { toWireConversationEvent, type GatewayConversationEvent } from '@/gateway/runtime'
import { FileConversationEventStore } from '@/platform/storage'
import { ScriptedAgentProvider } from '../test/support/scriptedAgentProvider'
import { GatewayToolOutputStore } from '@/gateway/toolOutputs'

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
        turn.finish('success')

        await expect(result).resolves.toMatchObject({ status: 'success' })
        expect(live.filter(event => event.kind === 'assistant_text_delta')).toMatchObject([
            { text: 'Building complete.' },
        ])
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
            event.kind === 'assistant_text_delta' ? event.text : '')).toEqual(['Building complete.'])
        expect(wire.filter(event => event.kind === 'turn_finished')).toHaveLength(1)

        await service.destroy()
        await fixture.events.close()
    })

    it('keeps a multi-megabyte tool result out of the Matrix event path and retains it only when opted in', async () => {
        const fixture = await createFixture()
        const provider = new ScriptedAgentProvider()
        const toolOutputs = await GatewayToolOutputStore.open(fixture.directory)
        const service = await GatewaySessionService.open({
            gatewayId: 'gateway-e2e', projects: fixture.projects, repository: fixture.repository,
            eventStore: fixture.events, providerFactory: () => provider, toolOutputStore: toolOutputs,
        })
        const session = await service.create(fixture.project.id, {
            provider: provider.name, title: 'Large output', config: { retainToolOutputs: true },
        })
        const result = service.sendMessage(session.id, 'Run verbose command', 'command-large', 'message-large')
        const turn = await provider.nextTurn()
        const body = 'x'.repeat(4 * 1024 * 1024)
        turn.emit({ kind: 'tool_use', toolUseId: 'tool-large', toolName: 'Bash', input: { command: body } })
        turn.emit({ kind: 'tool_result', toolUseId: 'tool-large', toolName: 'Bash', output: body, isError: false })
        turn.finish('success')
        await result

        const stored = await fixture.events.list(session.id)
        const wireTools = stored.events.flatMap(envelope => {
            const event = toWireConversationEvent(envelope.event)
            return event?.kind === 'tool' ? [event] : []
        })
        expect(wireTools).toHaveLength(2)
        expect(Math.max(...wireTools.map(event => JSON.stringify(event).length))).toBeLessThan(4_096)
        expect(JSON.stringify(wireTools)).not.toContain(body.slice(0, 1_000))
        expect(await toolOutputs.list(session.id)).toMatchObject([{
            toolCallId: 'tool-large', toolName: 'Bash', sizeBytes: expect.any(Number),
        }])

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
