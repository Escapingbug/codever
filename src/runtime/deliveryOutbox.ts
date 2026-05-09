import type { ChannelMessage, ChannelPort, ChannelSendResult } from '@/bridge/channelPort'

export type DeliveryStatus = 'pending' | 'sent' | 'edited' | 'failed' | 'skipped'

export interface DeliveryRecord {
    id: string
    kind: 'send' | 'edit'
    status: DeliveryStatus
    message: ChannelMessage
    messageId?: string | number
    error?: unknown
    createdAt: number
    completedAt?: number
}

export interface DeliveryOutboxConfig {
    channelPort: ChannelPort
    onFailure?: (record: DeliveryRecord) => void
}

export class DeliveryOutbox {
    private chain: Promise<void> = Promise.resolve()
    private records: DeliveryRecord[] = []
    private nextId = 0

    constructor(private config: DeliveryOutboxConfig) {}

    send(message: ChannelMessage, onSent?: (result: ChannelSendResult) => void): Promise<DeliveryRecord> {
        const record = this.createRecord('send', message)
        this.chain = this.chain.then(async () => {
            try {
                const result = await this.config.channelPort.send(message)
                record.status = 'sent'
                record.messageId = result.messageId
                onSent?.(result)
            } catch (error) {
                record.status = 'failed'
                record.error = error
                this.config.onFailure?.(record)
            } finally {
                record.completedAt = Date.now()
            }
        })
        return this.chain.then(() => record)
    }

    edit(messageId: string | number | undefined, message: ChannelMessage, fallbackToSend = true): Promise<DeliveryRecord> {
        if (messageId === undefined || messageId === null || !this.config.channelPort.edit) {
            if (fallbackToSend) return this.send(message)
            const skipped = this.createRecord('edit', message)
            skipped.status = 'skipped'
            skipped.completedAt = Date.now()
            return Promise.resolve(skipped)
        }

        const record = this.createRecord('edit', message)
        record.messageId = messageId
        this.chain = this.chain.then(async () => {
            try {
                await this.config.channelPort.edit!(messageId, message)
                record.status = 'edited'
            } catch (error) {
                record.status = 'failed'
                record.error = error
                this.config.onFailure?.(record)
                if (fallbackToSend) {
                    await this.config.channelPort.send(message)
                }
            } finally {
                record.completedAt = Date.now()
            }
        })
        return this.chain.then(() => record)
    }

    editDeferred(resolveMessageId: () => string | number | undefined, message: ChannelMessage, fallbackToSend = true): Promise<DeliveryRecord> {
        const record = this.createRecord('edit', message)
        this.chain = this.chain.then(async () => {
            const messageId = resolveMessageId()
            if (messageId === undefined || messageId === null || !this.config.channelPort.edit) {
                if (!fallbackToSend) {
                    record.status = 'skipped'
                    record.completedAt = Date.now()
                    return
                }
                try {
                    const result = await this.config.channelPort.send(message)
                    record.status = 'sent'
                    record.messageId = result.messageId
                } catch (error) {
                    record.status = 'failed'
                    record.error = error
                    this.config.onFailure?.(record)
                }
                record.completedAt = Date.now()
                return
            }

            record.messageId = messageId
            try {
                await this.config.channelPort.edit(messageId, message)
                record.status = 'edited'
            } catch (error) {
                record.status = 'failed'
                record.error = error
                this.config.onFailure?.(record)
                if (fallbackToSend) {
                    const result = await this.config.channelPort.send(message)
                    record.status = 'sent'
                    record.messageId = result.messageId
                }
            } finally {
                record.completedAt = Date.now()
            }
        })
        return this.chain.then(() => record)
    }

    async drain(): Promise<DeliveryRecord[]> {
        await this.chain
        return [...this.records]
    }

    list(): DeliveryRecord[] {
        return [...this.records]
    }

    private createRecord(kind: 'send' | 'edit', message: ChannelMessage): DeliveryRecord {
        const record: DeliveryRecord = {
            id: `delivery-${++this.nextId}`,
            kind,
            status: 'pending',
            message,
            createdAt: Date.now(),
        }
        this.records.push(record)
        return record
    }
}
