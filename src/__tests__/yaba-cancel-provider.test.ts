import { describe, it, expect, vi } from 'vitest'
import { AcpProvider } from '@/providers/acp'

// T1: 验证 cancel 后 provider 状态变化
// 由于 AcpProvider 需要真实的子进程，我们用 mock 来测试状态机逻辑
describe('YABA T1: cancel 后 provider 状态', () => {
  it('close() 应该将 connected 设为 false', async () => {
    // 创建一个 mock AcpProvider 来测试状态转换
    const provider = new AcpProvider({
      name: 'test',
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
    })

    // 模拟初始化完成
    ;(provider as any).initialized = true
    const clientManager = (provider as any).clientManager
    clientManager._connected = true
    clientManager.connection = { signal: { aborted: false } }

    expect(provider.isReady()).toBe(true)

    // 模拟 forceCancelActivePrompt 中的 close()
    await clientManager.close()

    // 验证：close() 后 provider 应该不可用
    expect(clientManager._connected).toBe(false)
    expect(clientManager.connection).toBeNull()
    expect(provider.isReady()).toBe(false)
  })
})

describe('YABA T2: close() 后 init() 是否恢复', () => {
  it('close() 后再次 init() 应该恢复 connected', async () => {
    const provider = new AcpProvider({
      name: 'test',
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
    })

    // 模拟初始化完成
    ;(provider as any).initialized = true
    const clientManager = (provider as any).clientManager
    clientManager._connected = true
    clientManager.connection = { signal: { aborted: false } }

    expect(provider.isReady()).toBe(true)

    // 模拟 cancel 导致的 close
    await clientManager.close()
    expect(provider.isReady()).toBe(false)

    // 关键测试：再次调用 init() 是否会恢复？
    // 注意：AcpProvider.init() 有 guard: if (this.initialized) return
    await provider.init()

    // 由于 initialized=true，init() 会直接返回，不会重新连接
    expect(provider.isReady()).toBe(false)
  })
})

describe('YABA T3: AcpProvider.init() guard 行为', () => {
  it('init() 在 initialized=true 时直接返回，不会重连', async () => {
    const provider = new AcpProvider({
      name: 'test',
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
    })

    // 模拟已经初始化过
    ;(provider as any).initialized = true
    ;(provider as any).initPromise = null

    const doInitSpy = vi.fn()
    ;(provider as any)._doInit = doInitSpy

    await provider.init()

    // 验证：由于 initialized=true，_doInit 不会被调用
    expect(doInitSpy).not.toHaveBeenCalled()
  })
})

describe('YABA T4: 完整状态机 - cancel 后 provider 永久死亡', () => {
  it('模拟完整的 cancel → close → 再次查询 流程', async () => {
    const provider = new AcpProvider({
      name: 'test',
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
    })

    // Step 1: 模拟初始化完成，provider 可用
    ;(provider as any).initialized = true
    const clientManager = (provider as any).clientManager
    clientManager._connected = true
    clientManager.connection = { signal: { aborted: false } }
    expect(provider.isReady()).toBe(true)

    // Step 2: 模拟查询中，设置 activeSessionId
    ;(provider as any).activeSessionId = 'test-session'

    // Step 3: 模拟 cancel 超时后的 force close
    // 这是 forceCancelActivePrompt 的代码逻辑
    const response = undefined // cancel 超时，没有响应
    if (!response) {
      await clientManager.close()
    }

    // Step 4: 验证 provider 已死
    expect(provider.isReady()).toBe(false)

    // Step 5: 模拟用户发送新消息，coreSessionLauncher 检查 provider
    // 这是 coreSessionLauncher.ts 第 155-161 行的逻辑
    if (!provider.isReady()) {
      const err = provider.getInitError() ?? 'Provider not available'
      // 这就是用户看到的错误消息
      expect(err).toBe('Provider not available')
    }
  })
})
