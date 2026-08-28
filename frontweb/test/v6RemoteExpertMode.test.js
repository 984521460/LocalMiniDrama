import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'

import {
  expertTunnelClosedView,
  expertTunnelRequestPayload,
  expertTunnelView,
} from '../src/components/remote/expertTunnelContract.js'

const CONNECTION_UID = '00000000-0000-4000-8000-000000009910'

function tunnel(overrides = {}) {
  return {
    contractVersion: 'remote-expert-tunnel.v1',
    connectionUid: CONNECTION_UID,
    status: 'ready',
    origin: 'http://127.0.0.1:49152',
    ...overrides,
  }
}

test('expert tunnel contract accepts only an exact managed loopback origin', () => {
  const view = expertTunnelView(tunnel())
  assert.deepEqual(view, tunnel())
  assert.ok(Object.isFrozen(view))
  assert.deepEqual(expertTunnelRequestPayload({}), {})
  assert.ok(Object.isFrozen(expertTunnelRequestPayload({})))

  for (const origin of [
    'https://127.0.0.1:49152',
    'http://localhost:49152',
    'http://0.0.0.0:49152',
    'http://[::1]:49152',
    'http://127.0.0.1:49152/path',
    'http://127.0.0.1:49152?next=private',
    'http://user@127.0.0.1:49152',
    'http://127.0.0.1:0',
  ]) assert.throws(() => expertTunnelView(tunnel({ origin })))
  assert.throws(() => expertTunnelView(tunnel({ status: 'opening' })))
  assert.throws(() => expertTunnelView({ ...tunnel(), host: '127.0.0.1' }))
  assert.throws(() => expertTunnelRequestPayload({ host: '127.0.0.1' }))
  assert.throws(() => expertTunnelRequestPayload({ port: 8188 }))
  assert.throws(() => expertTunnelRequestPayload({ scheme: 'http' }))
  assert.deepEqual(expertTunnelClosedView({
    contractVersion: 'remote-expert-tunnel.v1',
    connectionUid: CONNECTION_UID,
    status: 'closed',
  }, CONNECTION_UID), {
    contractVersion: 'remote-expert-tunnel.v1',
    connectionUid: CONNECTION_UID,
    status: 'closed',
  })
})

test('expert mode API always submits an empty request and validates the returned tunnel', () => {
  const apiSource = fs.readFileSync(
    path.resolve('src/api/v2/remoteConnections.js'),
    'utf8',
  )
  assert.match(apiSource, /openExpertTunnel\(connectionUid\)/u)
  assert.match(apiSource, /closeExpertTunnel\(connectionUid\)/u)
  assert.match(apiSource, /\/expert-tunnel/u)
  assert.match(apiSource, /expertTunnelRequestPayload\(\{\}\)/u)
  assert.match(apiSource, /expertTunnelView/u)
  assert.doesNotMatch(apiSource, /openExpertTunnel\([^)]*,/u)
})

test('expert mode component is explicit, status-gated, and opens only the validated local link', () => {
  const filename = path.resolve('src/components/remote/RemoteExpertMode.vue')
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [])
  assert.doesNotThrow(() => compileScript(parsed.descriptor, { id: 'remote-expert-mode' }))
  const compiled = compileTemplate({
    id: 'remote-expert-mode',
    filename,
    source: parsed.descriptor.template.content,
  })
  assert.deepEqual(compiled.errors, [])
  assert.match(source, /专家模式/u)
  assert.match(source, /connectionStatus === 'ready'/u)
  assert.match(source, /关闭专家模式隧道/u)
  assert.match(source, /target="_blank"/u)
  assert.match(source, /rel="noopener noreferrer"/u)
  assert.doesNotMatch(source, /window\.open|v-html|innerHTML|eval\s*\(/u)
})
