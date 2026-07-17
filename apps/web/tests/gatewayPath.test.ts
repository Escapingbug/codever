import { describe, expect, it } from 'vitest'
import { gatewayPathHelp, gatewayPathPlaceholder, validateGatewayPath } from '../src/gatewayPath'

describe('Gateway project paths', () => {
  it('accepts Windows drive and UNC paths for Windows Gateways', () => {
    expect(validateGatewayPath('D:\\work\\project', 'windows')).toBeUndefined()
    expect(validateGatewayPath('\\\\server\\share\\project', 'windows')).toBeUndefined()
    expect(validateGatewayPath('/srv/project', 'windows')).toContain('Windows')
    expect(gatewayPathPlaceholder('windows')).toBe('D:\\work\\project')
  })

  it('uses the filesystem namespace exposed by Unix and container Gateways', () => {
    expect(validateGatewayPath('/workspace/project', 'container')).toBeUndefined()
    expect(validateGatewayPath('D:\\project', 'container')).toContain('container')
    expect(gatewayPathPlaceholder('container')).toBe('/workspace/project')
    expect(gatewayPathHelp('container')).toContain('inside the container')
  })
})
