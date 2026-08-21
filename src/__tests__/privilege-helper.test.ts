import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateTotp } from '@codever/security'
import {
  PRIVILEGE_HELPER_PROTOCOL_VERSION,
  PrivilegeHelperClientError,
  UnixSocketPrivilegeExecutor,
  privilegeHelperInstallLayout,
  privilegeTotpProvisioningUri,
  startPrivilegeHelperServer,
  type PrivilegeHelperServer,
  type PrivilegedExecutionRequest,
} from '@/privilege'

const TEST_NOW = 1_900_000_000_000
const TEST_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

const directories: string[] = []
const servers: PrivilegeHelperServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  )
})

describe.skipIf(process.platform === 'win32')('Privilege Helper', () => {
  it('uses per-Gateway system service and credential paths on Linux and macOS', () => {
    expect(privilegeHelperInstallLayout('linux', 1000, '/srv/codever')).toMatchObject({
      serviceName: 'codever-privilege-helper-1000.service',
      servicePath: '/etc/systemd/system/codever-privilege-helper-1000.service',
      socketPath: '/var/run/codever-privilege-helper-1000.sock',
      credentialPath: '/srv/codever/privilege-client.json',
    })
    expect(privilegeHelperInstallLayout('darwin', 501, '/Users/me/gateway')).toMatchObject({
      serviceName: 'io.codever.privilege-helper.501',
      servicePath: '/Library/LaunchDaemons/io.codever.privilege-helper.501.plist',
      socketPath: '/var/run/codever-privilege-helper-501.sock',
      credentialPath: '/Users/me/gateway/privilege-client.json',
    })
    expect(privilegeTotpProvisioningUri(
      TEST_TOTP_SECRET,
      'codever-privilege-helper-1000.service',
    )).toContain(
      `secret=${TEST_TOTP_SECRET}&issuer=Codever&algorithm=SHA1&digits=6&period=30`,
    )
  })

  it('authenticates its owner-only client, executes exact argv, and rejects replay', async () => {
    const fixture = await helperFixture(['/bin/echo'])
    await expect(fixture.client.status()).resolves.toEqual({
      version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
      state: 'ready',
      totpRequired: true,
    })

    const request = executionRequest({
      executable: '/bin/echo',
      args: ['hello; this is not a shell'],
      cwd: fixture.directory,
      totp: await fixture.totp(),
    })
    await expect(fixture.client.execute(request)).resolves.toMatchObject({
      requestId: request.requestId,
      status: 'succeeded',
      exitCode: 0,
      stdout: 'hello; this is not a shell\n',
    })
    await expect(fixture.client.execute(request)).rejects.toMatchObject({
      status: 409,
      code: 'request_replayed',
    } satisfies Partial<PrivilegeHelperClientError>)
  })

  it('requires a valid, previously unused TOTP code', async () => {
    const fixture = await helperFixture(['/bin/echo'])
    const invalid = executionRequest({
      executable: '/bin/echo',
      args: ['invalid'],
      cwd: fixture.directory,
      totp: '000000',
    })
    await expect(fixture.client.execute(invalid)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_totp',
    } satisfies Partial<PrivilegeHelperClientError>)

    const valid = executionRequest({
      executable: '/bin/echo',
      args: ['valid'],
      cwd: fixture.directory,
      totp: await fixture.totp(),
    })
    await expect(fixture.client.execute(valid)).resolves.toMatchObject({
      status: 'succeeded',
    })
    await expect(fixture.client.execute(executionRequest({
      executable: '/bin/echo',
      args: ['replayed-code'],
      cwd: fixture.directory,
      totp: valid.totp,
    }))).rejects.toMatchObject({
      status: 409,
      code: 'totp_replayed',
    } satisfies Partial<PrivilegeHelperClientError>)
  })

  it('rate-limits repeated invalid TOTP guesses', async () => {
    const fixture = await helperFixture(['/bin/echo'])
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(fixture.client.execute(executionRequest({
        executable: '/bin/echo',
        args: [`invalid-${attempt}`],
        cwd: fixture.directory,
        totp: '000000',
      }))).rejects.toMatchObject({
        status: 401,
        code: 'invalid_totp',
      } satisfies Partial<PrivilegeHelperClientError>)
    }
    await expect(fixture.client.execute(executionRequest({
      executable: '/bin/echo',
      args: ['rate-limited'],
      cwd: fixture.directory,
      totp: await fixture.totp(),
    }))).rejects.toMatchObject({
      status: 429,
      code: 'totp_rate_limited',
    } satisfies Partial<PrivilegeHelperClientError>)
  })

  it('rejects invalid credentials, expired grants, and executables outside host policy', async () => {
    const fixture = await helperFixture(['/bin/echo'])
    const wrongCredential = join(fixture.directory, 'wrong-client.json')
    await writeCredential(wrongCredential, fixture.socketPath, randomBytes(32).toString('base64url'))
    await expect(new UnixSocketPrivilegeExecutor(wrongCredential).status()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    } satisfies Partial<PrivilegeHelperClientError>)

    const expired = executionRequest({
      executable: '/bin/echo',
      args: [],
      cwd: fixture.directory,
      totp: await fixture.totp(),
      requestedAt: TEST_NOW - 60_000,
      expiresAt: TEST_NOW - 30_000,
    })
    await expect(fixture.client.execute(expired)).rejects.toMatchObject({
      status: 409,
      code: 'request_expired',
    } satisfies Partial<PrivilegeHelperClientError>)

    const futureRequestedAt = TEST_NOW + 60_000
    const future = executionRequest({
      executable: '/bin/echo',
      args: [],
      cwd: fixture.directory,
      totp: await fixture.totp(),
      requestedAt: futureRequestedAt,
      expiresAt: futureRequestedAt + 30_000,
    })
    await expect(fixture.client.execute(future)).rejects.toMatchObject({
      status: 409,
      code: 'request_not_yet_valid',
    } satisfies Partial<PrivilegeHelperClientError>)

    const denied = executionRequest({
      executable: '/bin/pwd',
      args: [],
      cwd: fixture.directory,
      totp: await fixture.totp(),
    })
    await expect(fixture.client.execute(denied)).rejects.toMatchObject({
      status: 403,
      code: 'executable_not_allowed',
    } satisfies Partial<PrivilegeHelperClientError>)
  })
})

async function helperFixture(allowedExecutables: string[]): Promise<{
  directory: string
  socketPath: string
  client: UnixSocketPrivilegeExecutor
  totp(): Promise<string>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'codever-privilege-helper-'))
  directories.push(directory)
  const socketPath = join(directory, 'helper.sock')
  const credentialPath = join(directory, 'client.json')
  const token = randomBytes(32).toString('base64url')
  await writeCredential(credentialPath, socketPath, token)
  const server = await startPrivilegeHelperServer({
    config: {
      version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
      socketPath,
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      allowedUid: process.getuid?.() ?? 0,
      allowedGid: process.getgid?.() ?? 0,
      replayDirectory: join(directory, 'replay'),
      totp: {
        secret: TEST_TOTP_SECRET,
        algorithm: 'SHA-1',
        digits: 6,
        periodSeconds: 30,
        allowedClockSkewSteps: 1,
      },
      policy: {
        allowArbitraryRootExecutables: false,
        allowedExecutables,
      },
    },
    now: () => TEST_NOW,
  })
  servers.push(server)
  return {
    directory,
    socketPath,
    client: new UnixSocketPrivilegeExecutor(credentialPath),
    totp: () => generateTotp(TEST_TOTP_SECRET, { timeMs: TEST_NOW }),
  }
}

async function writeCredential(
  path: string,
  socketPath: string,
  token: string,
): Promise<void> {
  await writeFile(path, JSON.stringify({
    version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
    socketPath,
    token,
  }), { mode: 0o600 })
  await chmod(path, 0o600)
}

function executionRequest(
  input: Pick<PrivilegedExecutionRequest, 'executable' | 'args' | 'cwd' | 'totp'>
    & Partial<Pick<PrivilegedExecutionRequest, 'requestedAt' | 'expiresAt'>>,
): PrivilegedExecutionRequest {
  const requestedAt = input.requestedAt ?? TEST_NOW
  return {
    version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
    requestId: randomUUID(),
    sessionId: 'session-1',
    totp: input.totp,
    executable: input.executable,
    args: input.args,
    reason: 'Integration test',
    timeoutMs: 5_000,
    cwd: input.cwd,
    requestedAt,
    expiresAt: input.expiresAt ?? requestedAt + 30_000,
  }
}
