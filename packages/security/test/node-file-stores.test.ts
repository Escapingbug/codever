import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileIdempotencyStore, FileReplayStore } from '../src/node/index.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codever-security-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = resolve(directory)
    const temporaryRoot = `${resolve(tmpdir())}${sep}`
    if (!resolved.startsWith(temporaryRoot)) {
      throw new Error(`Refusing to clean unexpected test path: ${resolved}`)
    }
    await rm(resolved, { recursive: true, force: true })
  }
})

describe('FileReplayStore', () => {
  it('serializes concurrent transactions from one store before taking the process lock', async () => {
    const path = join(await temporaryDirectory(), 'replay.json')
    const store = new FileReplayStore(path, { lockTimeoutMs: 1, retryDelayMs: 1 })
    const claims = Array.from({ length: 64 }, (_, index) => ({
      key: `local-${index}`,
      expiresAt: 2_000,
    }))

    await expect(Promise.all(
      claims.map(claim => store.claimAll([claim], 1_000)),
    )).resolves.toEqual(claims.map(() => true))
    await expect(
      new FileReplayStore(path).claimAll(claims, 1_000),
    ).resolves.toBe(false)
  })

  it('atomically allows one claim across independent store instances', async () => {
    const path = join(await temporaryDirectory(), 'replay.json')
    const first = new FileReplayStore(path)
    const second = new FileReplayStore(path)
    const claims = [{ key: 'same-nonce', expiresAt: 2_000 }]

    const results = await Promise.all([
      first.claimAll(claims, 1_000),
      second.claimAll(claims, 1_000),
    ])
    expect(results.sort()).toEqual([false, true])
    await expect(new FileReplayStore(path).claimAll(claims, 1_000)).resolves.toBe(false)
  })

  it('recovers a synced next-state file after an interrupted replacement', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'replay.json')
    await writeFile(
      `${path}.next`,
      JSON.stringify({ version: 1, claims: { recovered: 2_000 } }),
      'utf8',
    )
    await expect(
      new FileReplayStore(path).claimAll([{ key: 'recovered', expiresAt: 2_000 }], 1_000),
    ).resolves.toBe(false)
  })

  it('does not guess that an existing process lock is stale', async () => {
    const path = join(await temporaryDirectory(), 'replay.json')
    await mkdir(`${path}.lock`)
    const store = new FileReplayStore(path, { lockTimeoutMs: 20, retryDelayMs: 2 })
    await expect(
      store.claimAll([{ key: 'nonce', expiresAt: 2_000 }], 1_000),
    ).rejects.toThrow('remove this lock path manually')
  })

  it('ignores a candidate left by a process killed before atomic publication', async () => {
    const path = join(await temporaryDirectory(), 'replay.json')
    await writeFile(
      `${path}.lock.candidate.12345.crashed-owner-token`,
      JSON.stringify({
        version: 1,
        pid: 12345,
        acquiredAt: Date.now(),
        token: 'crashed-owner-token',
      }),
      'utf8',
    )
    await expect(
      new FileReplayStore(path, { lockTimeoutMs: 2_000, retryDelayMs: 2 })
        .claimAll([{ key: 'after-candidate-crash', expiresAt: 2_000 }], 1_000),
    ).resolves.toBe(true)
  })

  it('recovers an atomically published lock left by an exited process', async () => {
    const path = join(await temporaryDirectory(), 'replay.json')
    const lockPath = `${path}.lock`
    const owner = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const p=process.argv[1];` +
          `fs.writeFileSync(p,JSON.stringify({` +
          `version:1,pid:process.pid,acquiredAt:Date.now(),token:'crashed-owner-token'` +
          `}));process.stdout.write('locked');setInterval(()=>{},1000);`,
        lockPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    await once(owner.stdout, 'data')
    owner.kill('SIGKILL')
    await once(owner, 'exit')

    await expect(
      new FileReplayStore(path, { lockTimeoutMs: 2_000, retryDelayMs: 2 })
        .claimAll([{ key: 'after-crash', expiresAt: 2_000 }], 1_000),
    ).resolves.toBe(true)
  })
})

describe('FileIdempotencyStore', () => {
  it('persists one execution claim and its completed result', async () => {
    const path = join(await temporaryDirectory(), 'ledger.json')
    const first = new FileIdempotencyStore<{ answer: string }>(path)
    const second = new FileIdempotencyStore<{ answer: string }>(path)

    const claims = await Promise.all([
      first.claim('command', 'fingerprint', 1_000, 3_000),
      second.claim('command', 'fingerprint', 1_000, 3_000),
    ])
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)

    await new FileIdempotencyStore<{ answer: string }>(path).settle(
      'command',
      'fingerprint',
      { status: 'completed', completedAt: 1_100, result: { answer: 'done' } },
    )
    await expect(
      new FileIdempotencyStore<{ answer: string }>(path).claim(
        'command',
        'fingerprint',
        1_200,
        3_000,
      ),
    ).resolves.toMatchObject({
      claimed: false,
      record: { status: 'completed', result: { answer: 'done' } },
    })
  })
})
