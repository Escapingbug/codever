/**
 * CodebuddyProvider — ACP-based Codebuddy integration.
 *
 * Uses the Agent Client Protocol to communicate with `codebuddy acp`
 * via stdio JSON-RPC. This replaces the previous @tencent-ai/agent-sdk
 * approach, gaining ACP's explicit session lifecycle guarantees.
 *
 * ACP's session/cancel only stops the current turn — the session persists
 * for the next session/prompt, fixing the "new session after interrupt" bug.
 */

import { AcpProvider, type AcpProviderConfig } from '@/providers/acp'

const CODEBUDDY_ACP_COMMAND = 'codebuddy'
const CODEBUDDY_ACP_ARGS = ['acp']

export class CodebuddyProvider extends AcpProvider {
    constructor() {
        super({
            name: 'codebuddy',
            command: CODEBUDDY_ACP_COMMAND,
            args: CODEBUDDY_ACP_ARGS,
        })
    }
}
