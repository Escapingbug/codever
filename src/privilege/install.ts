import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { encodeBase32 } from '@codever/security'
import { UnixSocketPrivilegeExecutor } from './helperClient.js'
import {
  PRIVILEGE_HELPER_PROTOCOL_VERSION,
  privilegeClientCredentialSchema,
  privilegeHelperConfigSchema,
  type PrivilegeClientCredential,
} from './protocol.js'

export interface InstallPrivilegeHelperOptions {
  gatewayDataDirectory: string
  helperBundlePath: string
  nodePath?: string
  targetUid?: number
  targetGid?: number
  allowedExecutables?: readonly string[]
  allowArbitraryRootExecutables?: boolean
  platform?: NodeJS.Platform
  healthTimeoutMs?: number
}

export interface PrivilegeHelperInstallLayout {
  installRoot: string
  nodePath: string
  helperPath: string
  configPath: string
  credentialPath: string
  replayDirectory: string
  socketPath: string
  serviceName: string
  servicePath: string
}

export interface InstalledPrivilegeHelper {
  layout: PrivilegeHelperInstallLayout
  targetUid: number
  targetGid: number
  allowedExecutables: string[]
  allowArbitraryRootExecutables: boolean
  totpSecret: string
  totpProvisioningUri: string
}

export interface InstallPrivilegeHelperDependencies {
  runCommand?: (executable: string, arguments_: readonly string[]) => Promise<void>
  sleep?: (milliseconds: number) => Promise<void>
}

export async function installPrivilegeHelper(
  input: InstallPrivilegeHelperOptions,
  dependencies: InstallPrivilegeHelperDependencies = {},
): Promise<InstalledPrivilegeHelper> {
  if (process.getuid?.() !== 0) {
    throw new Error('Privilege Helper installation must be run with sudo or as root')
  }
  const platform = input.platform ?? process.platform
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error('Privilege Helper installation supports Linux and macOS only')
  }
  const targetUid = input.targetUid ?? environmentIdentity('SUDO_UID')
  const targetGid = input.targetGid ?? environmentIdentity('SUDO_GID')
  if (targetUid === undefined || targetGid === undefined) {
    throw new Error(
      'Cannot identify the Gateway user; run through sudo or provide --target-uid and --target-gid',
    )
  }
  if (targetUid === 0) {
    throw new Error('The Matrix Gateway must run as a non-root user')
  }

  const gatewayDataDirectory = resolve(input.gatewayDataDirectory)
  const helperBundlePath = resolve(input.helperBundlePath)
  const nodePath = resolve(input.nodePath ?? process.execPath)
  const allowArbitraryRootExecutables = input.allowArbitraryRootExecutables ?? false
  const allowedExecutables = await validateAllowedExecutables(
    input.allowedExecutables ?? [],
  )
  if (!allowArbitraryRootExecutables && allowedExecutables.length === 0) {
    throw new Error(
      'At least one --allow-executable is required unless arbitrary root executables are explicitly enabled',
    )
  }
  await validateInstallSource(nodePath, true)
  await validateInstallSource(helperBundlePath, false)

  const layout = privilegeHelperInstallLayout(platform, targetUid, gatewayDataDirectory)
  await ensureRootDirectory(layout.installRoot, 0o755)
  await ensureRootDirectory(dirname(layout.configPath), 0o755)
  await ensureRootDirectory(layout.replayDirectory, 0o700)
  await ensureGatewayDataDirectory(gatewayDataDirectory, targetUid)

  await atomicCopy(nodePath, layout.nodePath, 0o755, 0, 0)
  await atomicCopy(helperBundlePath, layout.helperPath, 0o755, 0, 0)

  const token = randomBytes(32).toString('base64url')
  const totpSecret = encodeBase32(randomBytes(20))
  const config = privilegeHelperConfigSchema.parse({
    version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
    socketPath: layout.socketPath,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    allowedUid: targetUid,
    allowedGid: targetGid,
    replayDirectory: layout.replayDirectory,
    totp: {
      secret: totpSecret,
      algorithm: 'SHA-1',
      digits: 6,
      periodSeconds: 30,
      allowedClockSkewSteps: 1,
    },
    policy: {
      allowArbitraryRootExecutables,
      allowedExecutables,
    },
  })
  const credential = privilegeClientCredentialSchema.parse({
    version: PRIVILEGE_HELPER_PROTOCOL_VERSION,
    socketPath: layout.socketPath,
    token,
  })
  await atomicWriteJson(layout.configPath, config, 0o600, 0, 0)
  await atomicWriteJson(
    layout.credentialPath,
    credential,
    0o600,
    targetUid,
    targetGid,
  )

  const service = platform === 'darwin'
    ? macosLaunchDaemon(layout)
    : linuxSystemdUnit(layout)
  await atomicWrite(layout.servicePath, service, 0o644, 0, 0)
  await activateService(
    platform,
    layout,
    dependencies.runCommand ?? runCommand,
  )
  await waitForHelper(
    layout.credentialPath,
    input.healthTimeoutMs ?? 15_000,
    dependencies.sleep ?? sleep,
  )
  return {
    layout,
    targetUid,
    targetGid,
    allowedExecutables,
    allowArbitraryRootExecutables,
    totpSecret,
    totpProvisioningUri: privilegeTotpProvisioningUri(
      totpSecret,
      layout.serviceName,
    ),
  }
}

export function privilegeTotpProvisioningUri(
  secret: string,
  account: string,
): string {
  const label = encodeURIComponent(`Codever:${account}`)
  const parameters = new URLSearchParams({
    secret,
    issuer: 'Codever',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${label}?${parameters.toString()}`
}

export function privilegeHelperInstallLayout(
  platform: 'linux' | 'darwin',
  targetUid: number,
  gatewayDataDirectory: string,
): PrivilegeHelperInstallLayout {
  const serviceName = platform === 'darwin'
    ? `io.codever.privilege-helper.${targetUid}`
    : `codever-privilege-helper-${targetUid}.service`
  const installRoot = `/usr/local/libexec/codever-privilege-helper/${targetUid}`
  return {
    installRoot,
    nodePath: join(installRoot, 'node'),
    helperPath: join(installRoot, 'helper.js'),
    configPath: `/etc/codever/privilege-helper-${targetUid}.json`,
    credentialPath: join(gatewayDataDirectory, 'privilege-client.json'),
    replayDirectory: platform === 'darwin'
      ? `/var/db/codever-privilege-helper/${targetUid}/replay`
      : `/var/lib/codever-privilege-helper/${targetUid}/replay`,
    socketPath: `/var/run/codever-privilege-helper-${targetUid}.sock`,
    serviceName,
    servicePath: platform === 'darwin'
      ? `/Library/LaunchDaemons/${serviceName}.plist`
      : `/etc/systemd/system/${serviceName}`,
  }
}

async function validateAllowedExecutables(paths: readonly string[]): Promise<string[]> {
  const validated: string[] = []
  for (const path of paths) {
    if (!path.startsWith('/')) {
      throw new Error(`Allowed executable path must be absolute: ${path}`)
    }
    const canonical = await realpath(path)
    const metadata = await stat(canonical)
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error(
        `Allowed executable must be root-owned and not group/world writable: ${canonical}`,
      )
    }
    await access(canonical, fsConstants.X_OK)
    if (!validated.includes(canonical)) validated.push(canonical)
  }
  return validated
}

async function validateInstallSource(path: string, executable: boolean): Promise<void> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error(`Install source is not a regular file: ${path}`)
  await access(path, executable ? fsConstants.X_OK : fsConstants.R_OK)
}

async function ensureRootDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode })
  const metadata = await lstat(path)
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error(`Root installation directory is unsafe: ${path}`)
  }
  await chown(path, 0, 0)
  await chmod(path, mode)
}

async function ensureGatewayDataDirectory(
  path: string,
  targetUid: number,
): Promise<void> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    throw new Error(
      'Gateway data directory does not exist; create it as the Gateway user before running sudo',
    )
  }
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== targetUid
    || (metadata.mode & 0o022) !== 0
  ) {
    throw new Error(
      'Gateway data directory must be owned by the Gateway user and not group/world writable',
    )
  }
}

async function atomicCopy(
  source: string,
  destination: string,
  mode: number,
  uid: number,
  gid: number,
): Promise<void> {
  const temporary = temporaryPath(destination)
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL)
    await chown(temporary, uid, gid)
    await chmod(temporary, mode)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function atomicWriteJson(
  path: string,
  value: PrivilegeClientCredential | object,
  mode: number,
  uid: number,
  gid: number,
): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode, uid, gid)
}

async function atomicWrite(
  path: string,
  content: string,
  mode: number,
  uid: number,
  gid: number,
): Promise<void> {
  const temporary = temporaryPath(path)
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' })
    await chown(temporary, uid, gid)
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function linuxSystemdUnit(layout: PrivilegeHelperInstallLayout): string {
  return `[Unit]
Description=Codever Privilege Helper
After=local-fs.target

[Service]
Type=simple
ExecStart=${layout.nodePath} ${layout.helperPath} --config ${layout.configPath}
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=multi-user.target
`
}

function macosLaunchDaemon(layout: PrivilegeHelperInstallLayout): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(layout.serviceName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(layout.nodePath)}</string>
    <string>${xmlEscape(layout.helperPath)}</string>
    <string>--config</string>
    <string>${xmlEscape(layout.configPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`
}

async function activateService(
  platform: 'linux' | 'darwin',
  layout: PrivilegeHelperInstallLayout,
  execute: (executable: string, arguments_: readonly string[]) => Promise<void>,
): Promise<void> {
  if (platform === 'darwin') {
    const service = `system/${layout.serviceName}`
    await execute('/bin/launchctl', ['bootout', service]).catch(() => undefined)
    await execute('/bin/launchctl', ['bootstrap', 'system', layout.servicePath])
    await execute('/bin/launchctl', ['kickstart', '-k', service])
    return
  }
  const systemctl = await firstExecutable(['/usr/bin/systemctl', '/bin/systemctl'])
  await execute(systemctl, ['daemon-reload'])
  await execute(systemctl, ['enable', layout.serviceName])
  await execute(systemctl, ['restart', layout.serviceName])
}

async function waitForHelper(
  credentialPath: string,
  timeoutMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const executor = new UnixSocketPrivilegeExecutor(credentialPath)
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('Privilege Helper health check did not run')
  do {
    try {
      await executor.status()
      return
    } catch (error) {
      lastError = error
    }
    await wait(Math.min(250, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw new Error(`Privilege Helper did not become ready: ${formatError(lastError)}`)
}

function runCommand(executable: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`${executable} ${arguments_.join(' ')} exited with ${code}`))
    })
  })
}

async function firstExecutable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(`Required service manager was not found: ${candidates.join(', ')}`)
}

function environmentIdentity(name: 'SUDO_UID' | 'SUDO_GID'): number | undefined {
  const raw = process.env[name]
  if (!raw || !/^\d+$/u.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function temporaryPath(path: string): string {
  return `${path}.next.${process.pid}.${randomUUID()}`
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
