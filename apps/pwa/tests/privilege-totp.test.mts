import assert from 'node:assert/strict'
import test from 'node:test'
import { generateTotp } from '@codever/security'
import {
  enrollPrivilegeTotp,
  hasPrivilegeTotp,
  unlockPrivilegeTotp,
  type PrivilegeTotpEnvironment,
} from '../app/privilegeTotp.ts'

const setupKey = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('fingerprint PRF encrypts the TOTP key and unlocks the current code', async () => {
  const storage = new MemoryStorage()
  const prfOutput = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const credential = fakeCredential(prfOutput)
  let createCalls = 0
  let getCalls = 0
  const environment: PrivilegeTotpEnvironment = {
    credentials: {
      async create() {
        createCalls += 1
        return credential
      },
      async get() {
        getCalls += 1
        return credential
      },
    },
    crypto: globalThis.crypto,
    storage,
    now: () => 59_000,
  }

  const enrolledCode = await enrollPrivilegeTotp('gateway-1', setupKey, environment)
  assert.equal(enrolledCode, await generateTotp(setupKey, { timeMs: 59_000 }))
  assert.equal(createCalls, 1)
  assert.equal(getCalls, 0)
  assert.equal(hasPrivilegeTotp('gateway-1', environment), true)
  assert.equal(storage.value?.includes(setupKey), false)

  const unlockedCode = await unlockPrivilegeTotp('gateway-1', environment)
  assert.equal(unlockedCode, enrolledCode)
  assert.equal(getCalls, 1)
})

function fakeCredential(prfOutput: Uint8Array): PublicKeyCredential {
  return {
    id: 'credential-1',
    type: 'public-key',
    rawId: Uint8Array.of(1, 2, 3, 4).buffer,
    response: {} as AuthenticatorResponse,
    authenticatorAttachment: 'platform',
    getClientExtensionResults() {
      return {
        prf: { enabled: true, results: { first: prfOutput.slice().buffer } },
      } as AuthenticationExtensionsClientOutputs
    },
    toJSON() {
      return {}
    },
  }
}

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  value: string | null = null

  getItem(): string | null {
    return this.value
  }

  setItem(_key: string, value: string): void {
    this.value = value
  }

  removeItem(): void {
    this.value = null
  }
}
