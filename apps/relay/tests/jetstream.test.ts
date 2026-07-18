import { describe, expect, it } from 'vitest'
import { CODEVER_STREAMS } from '@codever/protocol'
import { CODEVER_STREAM_TOPOLOGY } from '../src/jetstream'

describe('Codever JetStream topology', () => {
    it('has one uniquely named stream for every durable data class', () => {
        const names = CODEVER_STREAM_TOPOLOGY.map(stream => stream.name)
        expect(new Set(names).size).toBe(names.length)
        expect(names).toEqual([
            CODEVER_STREAMS.commands,
            CODEVER_STREAMS.responses,
            CODEVER_STREAMS.events,
            CODEVER_STREAMS.inventory,
            CODEVER_STREAMS.pairing,
            CODEVER_STREAMS.presence,
        ])
    })

    it('keeps pairing short-lived and commands durable across Gateway disconnects', () => {
        const pairing = CODEVER_STREAM_TOPOLOGY.find(stream => stream.name === CODEVER_STREAMS.pairing)!
        const commands = CODEVER_STREAM_TOPOLOGY.find(stream => stream.name === CODEVER_STREAMS.commands)!
        expect(pairing.storage).toBe('file')
        expect(pairing.max_age).toBe(180_000_000_000)
        expect(commands.storage).toBe('file')
        expect(commands.retention).toBe('workqueue')
        expect(commands.max_age).toBeGreaterThan(pairing.max_age)
    })
})
