import { expect, test } from 'bun:test'

import { clientIp } from '../../src/server/client-ip'

test('no trusted proxies: use the socket address, ignore spoofed headers', () => {
  expect(clientIp('6.6.6.6', '10.0.0.1', 0)).toBe('10.0.0.1')
})

test('one trusted proxy: the right-most entry, not the client-supplied left ones', () => {
  expect(clientIp('6.6.6.6, 203.0.113.9', '10.0.0.1', 1)).toBe('203.0.113.9')
})

test('two trusted proxies (CDN in front of a platform proxy)', () => {
  expect(clientIp('6.6.6.6, 203.0.113.9, 198.51.100.2', '10.0.0.1', 2)).toBe('203.0.113.9')
})

test('missing or short header falls back to the socket', () => {
  expect(clientIp(null, '10.0.0.1', 1)).toBe('10.0.0.1')
  expect(clientIp('203.0.113.9', '10.0.0.1', 3)).toBe('10.0.0.1')
})
