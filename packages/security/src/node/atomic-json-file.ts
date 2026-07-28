import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface FileStoreOptions {
  /**
   * Maximum time spent waiting for another gateway process. A process must use
   * one store instance per file and all processes must honor the same lock.
   */
  lockTimeoutMs?: number
  retryDelayMs?: number
  /** Unix permissions applied at creation time, before sensitive bytes exist. */
  fileMode?: number
  /** Unix permissions for newly-created state and lock directories. */
  directoryMode?: number
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EEXIST'
  )
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

class CrossProcessFileLock {
  private readonly lockPath: string
  private readonly timeoutMs: number
  private readonly retryDelayMs: number
  private readonly fileMode: number
  private readonly directoryMode: number

  constructor(
    statePath: string,
    options: FileStoreOptions,
  ) {
    this.lockPath = `${statePath}.lock`
    this.timeoutMs = options.lockTimeoutMs ?? 5_000
    this.retryDelayMs = options.retryDelayMs ?? 10
    this.fileMode = options.fileMode ?? 0o600
    this.directoryMode = options.directoryMode ?? 0o700
  }

  async acquire(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.timeoutMs
    await mkdir(dirname(this.lockPath), { recursive: true, mode: this.directoryMode })

    for (;;) {
      try {
        await mkdir(this.lockPath, { mode: this.directoryMode })
        try {
          await writeFile(
            `${this.lockPath}/owner.json`,
            JSON.stringify({
              pid: process.pid,
              acquiredAt: Date.now(),
              token: randomUUID(),
            }),
            { encoding: 'utf8', flag: 'wx', mode: this.fileMode },
          )
        } catch (error) {
          await rmdir(this.lockPath).catch(() => undefined)
          throw error
        }

        let released = false
        return async () => {
          if (released) return
          released = true
          await unlink(`${this.lockPath}/owner.json`).catch((error: unknown) => {
            if (!isNotFound(error)) throw error
          })
          await rmdir(this.lockPath).catch((error: unknown) => {
            if (!isNotFound(error)) throw error
          })
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out acquiring security store lock ${this.lockPath}. ` +
              'If no gateway process is running, remove this lock directory manually.',
          )
        }
        await delay(this.retryDelayMs)
      }
    }
  }
}

async function readJsonCandidate<T>(path: string): Promise<{ found: boolean; value?: T }> {
  try {
    return { found: true, value: JSON.parse(await readFile(path, 'utf8')) as T }
  } catch (error) {
    if (isNotFound(error)) return { found: false }
    throw new Error(`Security state file is invalid: ${path}`, { cause: error })
  }
}

/**
 * JSON transaction file with a cross-process lock.
 *
 * Lock directories are intentionally not auto-broken: deciding that another
 * process is dead from elapsed wall-clock time is unsafe. After an unclean
 * process exit, an operator must remove the documented `.lock` directory.
 */
export class AtomicJsonFile<TState> {
  private readonly lock: CrossProcessFileLock
  private readonly nextPath: string
  private readonly previousPath: string
  private readonly fileMode: number
  private readonly directoryMode: number

  constructor(
    private readonly path: string,
    options: FileStoreOptions = {},
  ) {
    this.lock = new CrossProcessFileLock(path, options)
    this.nextPath = `${path}.next`
    this.previousPath = `${path}.previous`
    this.fileMode = options.fileMode ?? 0o600
    this.directoryMode = options.directoryMode ?? 0o700
  }

  async transaction<TResult>(
    createDefault: () => TState,
    operation: (state: TState) => { result: TResult; changed: boolean },
  ): Promise<TResult> {
    const release = await this.lock.acquire()
    try {
      const state = await this.read(createDefault)
      const { result, changed } = operation(state)
      if (changed) await this.write(state)
      return result
    } finally {
      await release()
    }
  }

  private async read(createDefault: () => TState): Promise<TState> {
    const primary = await readJsonCandidate<TState>(this.path)
    if (primary.found) return primary.value as TState

    // A missing primary with `.next` present means the process stopped after
    // moving the old state aside but before promoting the fully synced state.
    const next = await readJsonCandidate<TState>(this.nextPath)
    if (next.found) return next.value as TState
    const previous = await readJsonCandidate<TState>(this.previousPath)
    if (previous.found) return previous.value as TState
    return createDefault()
  }

  private async write(state: TState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: this.directoryMode })
    await rm(this.nextPath, { force: true })

    const handle = await open(this.nextPath, 'wx', this.fileMode)
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await rm(this.previousPath, { force: true })
    try {
      await rename(this.path, this.previousPath)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    await rename(this.nextPath, this.path)
    await rm(this.previousPath, { force: true })

    // Force metadata observation on platforms which lazily update directory
    // entries. Directory fsync is not consistently supported on Windows.
    await stat(this.path)
  }
}
