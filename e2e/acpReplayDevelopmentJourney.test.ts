import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import replayFixture from '../test/fixtures/acp/codex-development.json'
import recoveryFixture from '../test/fixtures/acp/codex-recovery.json'
import { createReplayAcpProvider, type AcpReplayFixture } from '../test/support/replayAcpClientManager'
import { ProjectRegistry } from '@/gateway/projects'
import { GatewaySessionService, FileSessionMetadataRepository } from '@/gateway/sessions'
import { toWireConversationEvent, type GatewayConversationEvent } from '@/gateway/runtime'
import { FileConversationEventStore } from '@/platform/storage'

const cleanup: string[] = []

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ACP replay development business journey', () => {
    it('C04/C05/C08 accepts, streams, stops, and continues one Codex session without duplicate turns', async () => {
        const fixture = await createFixture()
        const replay = createReplayAcpProvider(replayFixture as AcpReplayFixture)
        const service = await GatewaySessionService.open({
            ...fixture.options,
            providerFactory: () => replay.provider,
            providerDiscoveryFactory: () => replay.provider,
        })
        const session = await service.create(fixture.project.id, {
            provider: 'codex', title: 'Replay development', model: 'codex-model', config: {},
        })

        const accepted = await service.acceptMessage(session.id, {
            text: 'Create answer.txt with one line: first implementation',
            clientMessageId: 'client-develop',
            idempotencyKey: 'send-develop',
        })
        await expect(accepted.completion).resolves.toMatchObject({ status: 'success' })
        expect((await service.get(session.id)).providerSessionId).toBe('codex-replay-session-1')
        expect(replay.manager.observedModels).toContain('codex-model')

        const longTurn = await service.acceptMessage(session.id, {
            text: 'Run the long verification command',
            clientMessageId: 'client-interrupt',
            idempotencyKey: 'send-interrupt',
        })
        await replay.manager.waitUntilGate('long-command-running')
        await expect(service.cancel(session.id, 'User pressed Stop', 'stop-interrupt')).resolves.toBe(true)
        await expect(longTurn.completion).resolves.toMatchObject({ status: 'cancelled' })
        expect((await service.get(session.id)).state).toBe('idle')

        await service.setArchived(session.id, true, 'archive-once')
        expect((await service.get(session.id)).archivedAt).toBeTypeOf('string')
        await expect(service.sendMessage(session.id, {
            text: 'Adjust answer.txt by adding a second line: adjusted requirement',
            clientMessageId: 'client-adjust',
            idempotencyKey: 'send-adjust',
        })).resolves.toMatchObject({ status: 'success' })
        expect((await service.get(session.id)).archivedAt).toBeUndefined()

        const stored = await fixture.events.list(session.id)
        const wire = stored.events.flatMap(envelope => {
            const event = toWireConversationEvent(envelope.event)
            return event ? [event] : []
        })
        const userMessages = wire.filter(event => event.kind === 'user_message')
        expect(userMessages.map(event => event.kind === 'user_message' ? event.clientMessageId : undefined)).toEqual([
            'client-develop', 'client-interrupt', 'client-adjust',
        ])
        expect(wire.filter(event => event.kind === 'turn_finished').map(event =>
            event.kind === 'turn_finished' ? event.status : undefined)).toEqual(['success', 'cancelled', 'success'])
        expect(wire).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'tool', phase: 'completed', toolCallId: 'write-1' }),
            expect.objectContaining({ kind: 'assistant_text_delta', text: 'Updated the requirement.' }),
        ]))

        await service.destroy()
        await fixture.events.close()
    })

    it('C07 rebuilds a conversation from the durable cursor after a Client subscriber disconnects', async () => {
        const fixture = await createFixture()
        const replay = createReplayAcpProvider(replayFixture as AcpReplayFixture)
        const service = await GatewaySessionService.open({ ...fixture.options, providerFactory: () => replay.provider })
        const session = await service.create(fixture.project.id, { provider: 'codex', config: {} })
        const live: number[] = []
        const unsubscribe = service.subscribe(envelope => live.push(envelope.seq))

        await service.sendMessage(session.id, {
            text: 'Create answer.txt with one line: first implementation',
            clientMessageId: 'client-before-disconnect', idempotencyKey: 'before-disconnect',
        })
        const cursor = live.at(-1) ?? 0
        unsubscribe()

        const longTurn = await service.acceptMessage(session.id, {
            text: 'Run the long verification command',
            clientMessageId: 'client-while-offline', idempotencyKey: 'while-offline',
        })
        await replay.manager.waitUntilGate('long-command-running')
        await service.cancel(session.id, 'offline stop', 'offline-stop')
        await longTurn.completion

        const caughtUp = await fixture.events.list(session.id, { after: cursor })
        expect(caughtUp.events[0]?.seq).toBe(cursor + 1)
        expect(caughtUp.events.map(event => event.seq)).toEqual(
            caughtUp.events.map((_, index) => cursor + index + 1),
        )
        const wire = caughtUp.events.flatMap(envelope => {
            const event = toWireConversationEvent(envelope.event)
            return event ? [event] : []
        })
        expect(wire).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'user_message', clientMessageId: 'client-while-offline' }),
            expect.objectContaining({ kind: 'turn_finished', status: 'cancelled' }),
            expect.objectContaining({ kind: 'session_state', state: 'idle' }),
        ]))

        await service.destroy()
        await fixture.events.close()
    })

    it('C10 carries an ACP permission request through the durable decision and back to Codex', async () => {
        const fixture = await createFixture()
        const replay = createReplayAcpProvider({
            ...(replayFixture as AcpReplayFixture),
            turns: [(replayFixture as AcpReplayFixture).turns[3]!],
        })
        const service = await GatewaySessionService.open({ ...fixture.options, providerFactory: () => replay.provider })
        const session = await service.create(fixture.project.id, { provider: 'codex', config: {} })
        let resolveDecision!: (id: string) => void
        const decision = new Promise<string>(resolve => { resolveDecision = resolve })
        service.subscribe(envelope => {
            if (envelope.event.kind === 'decision' && envelope.event.phase === 'requested') {
                resolveDecision(envelope.event.decisionId)
            }
        })

        const turn = service.sendMessage(session.id, {
            text: 'Install the generated APK', clientMessageId: 'client-decision', idempotencyKey: 'send-decision',
        })
        await expect(service.respondDecision(session.id, await decision, 'allow', 'client-operator', 'decision-allow'))
            .resolves.toMatchObject({ status: 'accepted' })
        await expect(turn).resolves.toMatchObject({ status: 'success' })
        expect(replay.manager.permissionResults).toEqual([{ behavior: 'allow' }])

        const wire = (await fixture.events.list(session.id)).events.flatMap(envelope => {
            const event = toWireConversationEvent(envelope.event)
            return event ? [event] : []
        })
        expect(wire).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'decision_request', title: 'Allow Bash?' }),
            expect.objectContaining({ kind: 'decision_resolved', optionId: 'allow', resolvedBy: 'client-operator' }),
        ]))

        await service.destroy()
        await fixture.events.close()
    })

    it('C16 cancels an in-flight turn on Gateway shutdown and resumes the Provider session after restart', async () => {
        const fixture = await createFixture()
        const longReplay = createReplayAcpProvider({
            ...(replayFixture as AcpReplayFixture),
            turns: [(replayFixture as AcpReplayFixture).turns[1]!],
        })
        const first = await GatewaySessionService.open({ ...fixture.options, providerFactory: () => longReplay.provider })
        const session = await first.create(fixture.project.id, {
            provider: 'codex', providerSessionId: 'codex-replay-session-1', config: {},
        })
        const interrupted = await first.acceptMessage(session.id, {
            text: 'Run the long verification command', clientMessageId: 'before-restart', idempotencyKey: 'before-restart',
        })
        await longReplay.manager.waitUntilGate('long-command-running')
        await first.destroy()
        await expect(interrupted.completion).resolves.toMatchObject({ status: 'cancelled' })
        await fixture.events.close()

        const repository = await FileSessionMetadataRepository.open(fixture.metadataPath)
        const events = new FileConversationEventStore<GatewayConversationEvent>(fixture.eventsPath)
        const adjustmentReplay = createReplayAcpProvider({
            ...(replayFixture as AcpReplayFixture),
            turns: [(replayFixture as AcpReplayFixture).turns[2]!],
        })
        const restarted = await GatewaySessionService.open({
            gatewayId: 'gateway-replay', projects: fixture.projects, repository, eventStore: events,
            providerFactory: () => adjustmentReplay.provider,
        })

        await expect(restarted.sendMessage(session.id, {
            text: 'Adjust answer.txt by adding a second line: adjusted requirement',
            clientMessageId: 'after-restart', idempotencyKey: 'after-restart',
        })).resolves.toMatchObject({ status: 'success' })
        expect(adjustmentReplay.manager.observedResumeSessionIds).toContain('codex-replay-session-1')
        expect((await restarted.get(session.id)).state).toBe('idle')

        await restarted.destroy()
        await events.close()
    })

    it('C18 exposes refusal and transport failure, then recovers on the same Session', async () => {
        const fixture = await createFixture()
        const replay = createReplayAcpProvider(recoveryFixture as AcpReplayFixture)
        const service = await GatewaySessionService.open({ ...fixture.options, providerFactory: () => replay.provider })
        const session = await service.create(fixture.project.id, { provider: 'codex', config: {} })

        await expect(service.sendMessage(session.id, {
            text: 'Attempt a request that Codex refuses', clientMessageId: 'refused', idempotencyKey: 'refused',
        })).resolves.toMatchObject({ status: 'error', summary: 'Agent refused' })
        expect((await service.get(session.id)).state).toBe('error')

        await expect(service.sendMessage(session.id, {
            text: 'Attempt while the Provider transport fails', clientMessageId: 'transport-failure', idempotencyKey: 'transport-failure',
        })).resolves.toMatchObject({ status: 'error' })
        expect((await service.get(session.id)).state).toBe('error')

        await expect(service.sendMessage(session.id, {
            text: 'Retry the task after Provider recovery', clientMessageId: 'recovered', idempotencyKey: 'recovered',
        })).resolves.toMatchObject({ status: 'success' })
        expect((await service.get(session.id)).state).toBe('idle')
        expect(replay.manager.observedResumeSessionIds).toContain('codex-recovery-session-1')

        const wire = (await fixture.events.list(session.id)).events.flatMap(envelope => {
            const event = toWireConversationEvent(envelope.event)
            return event ? [event] : []
        })
        expect(wire.filter(event => event.kind === 'user_message')).toHaveLength(3)
        expect(wire.filter(event => event.kind === 'turn_finished').map(event =>
            event.kind === 'turn_finished' ? event.status : undefined)).toEqual(['error', 'error', 'success'])
        expect(wire).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'assistant_text_delta', text: 'Recovered and completed the task.' }),
            expect.objectContaining({ kind: 'session_state', state: 'idle' }),
        ]))

        await service.destroy()
        await fixture.events.close()
    })
})

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'codever-acp-replay-e2e-'))
    cleanup.push(directory)
    const root = join(directory, 'project')
    await mkdir(root, { recursive: true })
    const projects = await ProjectRegistry.open({ storagePath: join(directory, 'projects.json') })
    const project = await projects.create({ name: 'Replay Project', rootPath: root, defaultProvider: 'codex' })
    const repository = await FileSessionMetadataRepository.open(join(directory, 'sessions.json'))
    const events = new FileConversationEventStore<GatewayConversationEvent>(join(directory, 'events.jsonl'))
    return {
        project,
        events,
        projects,
        metadataPath: join(directory, 'sessions.json'),
        eventsPath: join(directory, 'events.jsonl'),
        options: { gatewayId: 'gateway-replay', projects, repository, eventStore: events },
    }
}
