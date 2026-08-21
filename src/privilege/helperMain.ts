import { readFile, stat } from 'node:fs/promises'
import { privilegeHelperConfigSchema } from './protocol.js'
import { startPrivilegeHelperServer } from './helperServer.js'

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('The Privilege Helper currently supports Linux and macOS only')
  }
  if (process.getuid?.() !== 0) {
    throw new Error('The Privilege Helper must run as root')
  }
  const configPath = argument('--config')
  const metadata = await stat(configPath)
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error('Privilege Helper config must be a root-owned, non-writable regular file')
  }
  const config = privilegeHelperConfigSchema.parse(
    JSON.parse(await readFile(configPath, 'utf8')),
  )
  const server = await startPrivilegeHelperServer({
    config,
    onLog: message => process.stderr.write(`${message}\n`),
  })
  const stop = () => {
    void server.stop().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

main().catch(error => {
  process.stderr.write(`[privilege-helper] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
