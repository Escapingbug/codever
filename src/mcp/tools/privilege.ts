import { z } from 'zod'
import { GatewayAdminClient } from '@/gateway/admin/client'
import { PRIVILEGE_APPROVAL_TIMEOUT_MS } from '@/privilege'

export interface PrivilegeToolEnvironment {
  sessionId?: string
  socketPath?: string
}

export function privilegeToolEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PrivilegeToolEnvironment {
  return {
    ...(environment.CODEVER_PRIVILEGE_AVAILABLE === '1'
      ? {
          sessionId: environment.CODEVER_SESSION_ID?.trim() || undefined,
          socketPath: environment.CODEVER_GATEWAY_ADMIN_SOCKET?.trim() || undefined,
        }
      : {}),
  }
}

export function createPrivilegedExecHandler(
  environment: PrivilegeToolEnvironment = privilegeToolEnvironment(),
) {
  return async (args: {
    executable: string
    arguments?: string[]
    reason: string
    timeoutSeconds?: number
  }) => {
    if (!environment.sessionId || !environment.socketPath) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: 'Remote privileged execution is not configured for this Codever session.',
        }],
      }
    }
    try {
      const timeoutMs = Math.round((args.timeoutSeconds ?? 300) * 1_000)
      const client = new GatewayAdminClient({
        socketPath: environment.socketPath,
        timeoutMs: timeoutMs + PRIVILEGE_APPROVAL_TIMEOUT_MS + 30_000,
      })
      const result = await client.privilegedExecution({
        sessionId: environment.sessionId,
        executable: args.executable,
        args: args.arguments ?? [],
        reason: args.reason,
        timeoutMs,
      })
      const lines = [
        `Privileged execution: ${result.status}`,
        `Exit code: ${result.exitCode ?? 'none'}`,
        ...(result.signal ? [`Signal: ${result.signal}`] : []),
        ...(result.truncated ? ['Output was truncated by the Privilege Helper.'] : []),
        ...(result.stdout ? [`stdout:\n${result.stdout}`] : []),
        ...(result.stderr ? [`stderr:\n${result.stderr}`] : []),
      ]
      return {
        ...(result.status === 'succeeded' ? {} : { isError: true }),
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Privileged execution failed: ${message}` }],
      }
    }
  }
}

export function registerPrivilegeTools(server: any): void {
  const environment = privilegeToolEnvironment()
  if (!environment.sessionId || !environment.socketPath) return
  server.tool(
    'privileged_exec',
    [
      'Run one exact executable as root through the Codever Privilege Helper.',
      'The connected administrator device must approve the displayed command unless a short session lease is active.',
      'Pass an absolute executable path and an argument array; do not combine a command into one shell string.',
    ].join(' '),
    {
      executable: z.string().startsWith('/').max(8_192)
        .describe('Absolute path of the root-owned executable to run.'),
      arguments: z.array(z.string().max(8_192)).max(256).optional()
        .describe('Arguments passed directly to the executable without a shell.'),
      reason: z.string().min(1).max(2_048)
        .describe('Why administrator privileges are required; shown to the approving user.'),
      timeoutSeconds: z.number().int().min(1).max(900).optional()
        .describe('Execution timeout in seconds. Defaults to 300.'),
    },
    createPrivilegedExecHandler(environment),
  )
}
