import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  canonicalJson,
  cvp3CommandSchema,
  cvp3EventSchema,
  type Cvp3Command,
  type Cvp3Event,
  type JsonValue,
} from '@codever/protocol'
import { SecurityError } from '@codever/security'

export type Cvp3CommandTerminal = {
  outcome: 'succeeded' | 'failed' | 'rejected' | 'interrupted'
  eventId: string
  /** Exact terminal event retained for crash-safe Matrix redelivery. */
  event?: Cvp3Event
  sessionId?: string
  code?: string
  error?: string
  result?: JsonValue
}

export type Cvp3CommandJournalRecord = {
  command: Cvp3Command
  fingerprint: string
  roomId?: string
  matrixEventId?: string
  status: 'accepted' | 'dispatched' | 'terminal'
  acceptedAt: number
  dispatchedAt?: number
  terminalAt?: number
  terminal?: Cvp3CommandTerminal
  terminalDeliveryEventId?: string
}

type HeaderEntry = {
  version: 3
  kind: 'journal'
  generation: string
}

type AcceptedEntry = {
  version: 3
  kind: 'accepted'
  key: string
  fingerprint: string
  command: Cvp3Command
  roomId?: string
  matrixEventId?: string
  acceptedAt: number
}

type DispatchedEntry = {
  version: 3
  kind: 'dispatched'
  key: string
  fingerprint: string
  dispatchedAt: number
}

type TerminalEntry = {
  version: 3
  kind: 'terminal'
  key: string
  fingerprint: string
  terminalAt: number
  terminal: Cvp3CommandTerminal
}

type TerminalDeliveredEntry = {
  version: 3
  kind: 'terminal_delivered'
  key: string
  fingerprint: string
  matrixEventId: string
  deliveredAt: number
}

type JournalEntry = HeaderEntry | AcceptedEntry | DispatchedEntry | TerminalEntry | TerminalDeliveredEntry

export type Cvp3CommandClaim =
  | { kind: 'accepted'; record: Cvp3CommandJournalRecord }
  | { kind: 'duplicate'; record: Cvp3CommandJournalRecord }

/**
 * The CVP/3 execution-once boundary. Commands are independent durable objects;
 * there is deliberately no per-device sequence or workspace revision.
 */
export class FileCvp3CommandJournal {
  private readonly records = new Map<string, Cvp3CommandJournalRecord>()
  private initialized = false
  private generation: string | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  initialize(): Promise<void> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
    })
  }

  getGeneration(): string {
    if (!this.initialized || !this.generation) {
      throw new Error('CVP/3 command journal is not initialized')
    }
    return this.generation
  }

  claim(
    commandInput: Cvp3Command,
    now = Date.now(),
    context?: { roomId: string; matrixEventId: string },
  ): Promise<Cvp3CommandClaim> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      const command = cvp3CommandSchema.parse(commandInput)
      const key = commandKey(command)
      const fingerprint = commandFingerprint(command)
      const current = this.records.get(key)
      if (current) {
        if (current.fingerprint !== fingerprint) {
          throw new SecurityError(
            'idempotency_conflict',
            'Command ID was reused with different signed content',
          )
        }
        return { kind: 'duplicate', record: structuredClone(current) }
      }
      const entry: AcceptedEntry = {
        version: 3,
        kind: 'accepted',
        key,
        fingerprint,
        command,
        ...(context ? context : {}),
        acceptedAt: now,
      }
      await this.append(entry)
      const record: Cvp3CommandJournalRecord = {
        command,
        fingerprint,
        ...(context ? context : {}),
        status: 'accepted',
        acceptedAt: now,
      }
      this.records.set(key, record)
      return { kind: 'accepted', record: structuredClone(record) }
    })
  }

  markDispatched(command: Cvp3Command, now = Date.now()): Promise<void> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      const { key, record, fingerprint } = this.requireExact(command)
      if (record.status === 'terminal' || record.status === 'dispatched') return
      await this.append({
        version: 3,
        kind: 'dispatched',
        key,
        fingerprint,
        dispatchedAt: now,
      })
      record.status = 'dispatched'
      record.dispatchedAt = now
    })
  }

  settle(
    command: Cvp3Command,
    terminal: Cvp3CommandTerminal,
    now = Date.now(),
  ): Promise<void> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      const { key, record, fingerprint } = this.requireExact(command)
      if (record.status === 'terminal') {
        if (canonicalJson(record.terminal) !== canonicalJson(terminal)) {
          throw new Error('Command already has a different terminal result')
        }
        return
      }
      await this.append({
        version: 3,
        kind: 'terminal',
        key,
        fingerprint,
        terminalAt: now,
        terminal: structuredClone(terminal),
      })
      record.status = 'terminal'
      record.terminalAt = now
      record.terminal = structuredClone(terminal)
    })
  }

  get(command: Cvp3Command): Promise<Cvp3CommandJournalRecord | undefined> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      const current = this.records.get(commandKey(command))
      if (!current) return undefined
      if (current.fingerprint !== commandFingerprint(command)) {
        throw new SecurityError(
          'idempotency_conflict',
          'Command ID does not match its durable journal fingerprint',
        )
      }
      return structuredClone(current)
    })
  }

  unfinished(): Promise<Cvp3CommandJournalRecord[]> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      return [...this.records.values()]
        .filter(record => record.status !== 'terminal')
        .map(record => structuredClone(record))
    })
  }

  pendingTerminalDeliveries(): Promise<Cvp3CommandJournalRecord[]> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      return [...this.records.values()]
        .filter(record =>
          record.status === 'terminal'
          && record.terminal?.event !== undefined
          && record.terminalDeliveryEventId === undefined
        )
        .map(record => structuredClone(record))
    })
  }

  markTerminalDelivered(
    command: Cvp3Command,
    matrixEventId: string,
    now = Date.now(),
  ): Promise<void> {
    return this.serial(async () => {
      if (!this.initialized) await this.load()
      const { key, record, fingerprint } = this.requireExact(command)
      if (record.status !== 'terminal' || !record.terminal?.event) {
        throw new Error('Command has no durable terminal event to mark delivered')
      }
      if (record.terminalDeliveryEventId) {
        if (record.terminalDeliveryEventId !== matrixEventId) {
          throw new Error('Command terminal was delivered with a different Matrix event ID')
        }
        return
      }
      await this.append({
        version: 3,
        kind: 'terminal_delivered',
        key,
        fingerprint,
        matrixEventId,
        deliveredAt: now,
      })
      record.terminalDeliveryEventId = matrixEventId
    })
  }

  private requireExact(command: Cvp3Command): {
    key: string
    fingerprint: string
    record: Cvp3CommandJournalRecord
  } {
    const key = commandKey(command)
    const fingerprint = commandFingerprint(command)
    const record = this.records.get(key)
    if (!record || record.fingerprint !== fingerprint) {
      throw new Error('Command has no exact durable CVP/3 acceptance')
    }
    return { key, fingerprint, record }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) throw error
      this.generation = randomUUID()
      await this.append({ version: 3, kind: 'journal', generation: this.generation })
      this.initialized = true
      return
    }
    let headerCount = 0
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Corrupt CVP/3 command journal at line ${index + 1}`)
      }
      const entry = parseEntry(value, index + 1)
      if (entry.kind === 'journal') {
        headerCount += 1
        if (headerCount > 1) throw new Error('Duplicate CVP/3 command journal header')
        this.generation = entry.generation
        continue
      }
      if (entry.kind === 'accepted') {
        if (this.records.has(entry.key)) {
          throw new Error(`Duplicate CVP/3 command acceptance at line ${index + 1}`)
        }
        if (
          entry.key !== commandKey(entry.command)
          || entry.fingerprint !== commandFingerprint(entry.command)
        ) {
          throw new Error(`Invalid CVP/3 command acceptance binding at line ${index + 1}`)
        }
        this.records.set(entry.key, {
          command: entry.command,
          fingerprint: entry.fingerprint,
          ...(entry.roomId ? { roomId: entry.roomId } : {}),
          ...(entry.matrixEventId ? { matrixEventId: entry.matrixEventId } : {}),
          status: 'accepted',
          acceptedAt: entry.acceptedAt,
        })
        continue
      }
      const record = this.records.get(entry.key)
      if (!record || record.fingerprint !== entry.fingerprint) {
        throw new Error(`Orphaned CVP/3 command transition at line ${index + 1}`)
      }
      if (entry.kind === 'dispatched') {
        if (record.status !== 'accepted') {
          throw new Error(`Invalid CVP/3 dispatched transition at line ${index + 1}`)
        }
        record.status = 'dispatched'
        record.dispatchedAt = entry.dispatchedAt
      } else if (entry.kind === 'terminal') {
        if (record.status === 'terminal') {
          throw new Error(`Duplicate CVP/3 terminal transition at line ${index + 1}`)
        }
        record.status = 'terminal'
        record.terminalAt = entry.terminalAt
        record.terminal = structuredClone(entry.terminal)
      } else {
        if (record.status !== 'terminal' || record.terminalDeliveryEventId) {
          throw new Error(`Invalid CVP/3 terminal delivery at line ${index + 1}`)
        }
        record.terminalDeliveryEventId = entry.matrixEventId
      }
    }
    if (!this.generation) {
      throw new Error('CVP/3 command journal is missing its generation header')
    }
    this.initialized = true
  }

  private async append(entry: JournalEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const handle = await open(this.filePath, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

function commandKey(command: Cvp3Command): string {
  return canonicalJson([
    command.workspaceId,
    command.deviceId,
    command.certificateId,
    command.commandId,
  ])
}

function commandFingerprint(command: Cvp3Command): string {
  return `v3:${createHash('sha256')
    .update('codever-command:v3\0')
    .update(canonicalJson(command))
    .digest('hex')}`
}

function parseEntry(value: unknown, line: number): JournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid CVP/3 command journal entry at line ${line}`)
  }
  const entry = value as Record<string, unknown>
  if (entry.version !== 3) throw new Error(`Unsupported command journal version at line ${line}`)
  if (entry.kind === 'journal') {
    if (typeof entry.generation !== 'string' || !entry.generation) {
      throw new Error(`Invalid CVP/3 command journal header at line ${line}`)
    }
    return entry as HeaderEntry
  }
  if (
    typeof entry.key !== 'string'
    || !entry.key
    || typeof entry.fingerprint !== 'string'
    || !entry.fingerprint
  ) {
    throw new Error(`Invalid CVP/3 command journal binding at line ${line}`)
  }
  if (entry.kind === 'accepted') {
    if (!Number.isSafeInteger(entry.acceptedAt)) {
      throw new Error(`Invalid CVP/3 command acceptance time at line ${line}`)
    }
    return {
      version: 3,
      kind: 'accepted',
      key: entry.key,
      fingerprint: entry.fingerprint,
      command: cvp3CommandSchema.parse(entry.command),
      ...(typeof entry.roomId === 'string' && entry.roomId
        ? { roomId: entry.roomId }
        : {}),
      ...(typeof entry.matrixEventId === 'string' && entry.matrixEventId
        ? { matrixEventId: entry.matrixEventId }
        : {}),
      acceptedAt: entry.acceptedAt as number,
    }
  }
  if (entry.kind === 'dispatched') {
    if (!Number.isSafeInteger(entry.dispatchedAt)) {
      throw new Error(`Invalid CVP/3 command dispatch time at line ${line}`)
    }
    return entry as DispatchedEntry
  }
  if (entry.kind === 'terminal') {
    if (!Number.isSafeInteger(entry.terminalAt) || !isTerminal(entry.terminal)) {
      throw new Error(`Invalid CVP/3 command terminal entry at line ${line}`)
    }
    return entry as TerminalEntry
  }
  if (entry.kind === 'terminal_delivered') {
    if (
      !Number.isSafeInteger(entry.deliveredAt)
      || typeof entry.matrixEventId !== 'string'
      || !entry.matrixEventId
    ) {
      throw new Error(`Invalid CVP/3 command terminal delivery at line ${line}`)
    }
    return entry as TerminalDeliveredEntry
  }
  throw new Error(`Unknown CVP/3 command journal entry at line ${line}`)
}

function isTerminal(value: unknown): value is Cvp3CommandTerminal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const terminal = value as Record<string, unknown>
  return ['succeeded', 'failed', 'rejected', 'interrupted'].includes(String(terminal.outcome))
    && typeof terminal.eventId === 'string'
    && terminal.eventId.length > 0
    && (terminal.event === undefined || cvp3EventSchema.safeParse(terminal.event).success)
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
