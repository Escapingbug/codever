import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PRIVILEGE_HELPER_PROTOCOL_VERSION,
  PrivilegeHelperClientError,
  UnixSocketPrivilegeExecutor,
  privilegeHelperInstallLayout,
  startPrivilegeHelperServer,
  type PrivilegeHelperServer,
  type PrivilegedExecutionRequest,
} from '@/privilege'

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
  })

  it('authenticates its owner-only client, executes exact argv, and rejects replay', async () => {
    const fixture = await helperFixture(['/bin/echo'])
    await expect(fixture.client.status()).resolves.toEqual({
      version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
      state: 'ready',
    })

    const request = executionRequest({
      executable: '/bin/echo',
      args: ['hello; this is not a shell'],
      cwd: fixture.directory,
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
      requestedAt: Date.now() - 60_000,
      expiresAt: Date.now() - 30_000,
    })
    await expect(fixture.client.execute(expired)).rejects.toMatchObject({
      status: 409,
      code: 'request_expired',
    } satisfies Partial<PrivilegeHelperClientError>)

    const futureRequestedAt = Date.now() + 60_000
    const future = executionRequest({
      executable: '/bin/echo',
      args: [],
      cwd: fixture.directory,
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
      policy: {
        allowArbitraryRootExecutables: false,
        allowedExecutables,
      },
    },
  })
  servers.push(server)
  return {
    directory,
    socketPath,
    client: new UnixSocketPrivilegeExecutor(credentialPath),
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
  input: Pick<PrivilegedExecutionRequest, 'executable' | 'args' | 'cwd'>
    & Partial<Pick<PrivilegedExecutionRequest, 'requestedAt' | 'expiresAt'>>,
): PrivilegedExecutionRequest {
  const requestedAt = input.requestedAt ?? Date.now()
  return {
    version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
    requestId: randomUUID(),
    sessionId: 'session-1',
    executable: input.executable,
    args: input.args,
    reason: 'Integration test',
    timeoutMs: 5_000,
    cwd: input.cwd,
    requestedAt,
    expiresAt: input.expiresAt ?? requestedAt + 30_000,
  }
}
