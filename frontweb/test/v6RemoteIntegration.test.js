import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'

import {
  initializationResultView,
} from '../src/components/remote/environmentContract.js'

const CONNECTION_UID = '00000000-0000-4000-8000-000000009950'
const HASH = 'a'.repeat(64)

test('initialization result boundary validates core and model outcomes', () => {
  const report = {
    contractVersion: 'remote-environment-report.v2',
    connectionUid: CONNECTION_UID,
    collectedAtEpochMs: 0,
    profileVersion: '2.0.0',
    platform: 'linux',
    architecture: 'x64',
    gpuVendor: 'nvidia',
    gpuName: 'NVIDIA GeForce RTX 4090',
    gpuCount: 1,
    totalVramMiB: 24564,
    driverVersion: '595.84',
    systemMemoryMiB: 65536,
    diskFreeMiB: 524288,
    pythonVersion: '3.12.12',
    torchVersion: '2.11.0+cu130',
    cudaVersion: '13.0',
    ffmpegVersion: '8.1.2',
    comfyUiVersion: '0.33.0',
    comfyUiRevision: '0696f61d953d09878988ebc4ca46e263f73ff65f',
    workspaceWritable: true,
    directoriesReady: true,
    comfyUiReachable: true,
    ready: true,
  }
  const result = initializationResultView({
    contractVersion: 'remote-initialization-result.v2',
    connectionUid: CONNECTION_UID,
    planHash: HASH,
    kind: 'core',
    status: 'completed',
    steps: [
      { id: 'workspace-layout.v1', status: 'completed' },
      { id: 'python-runtime.v1', status: 'already-satisfied' },
      { id: 'ffmpeg-runtime.v1', status: 'completed' },
      { id: 'workflow-bundle.v1', status: 'completed' },
      { id: 'comfyui-version.v1', status: 'completed' },
      { id: 'custom-node-lock.v1', status: 'completed' },
      { id: 'environment-gate.v1', status: 'completed' },
    ],
    report,
  })
  assert.equal(result.report.ready, true)
  assert.throws(() => initializationResultView({ ...result, command: 'ignored' }))
  assert.throws(() => initializationResultView({
    ...result,
    connectionUid: '00000000-0000-4000-8000-000000009999',
  }, CONNECTION_UID))
});

test('remote connection API exposes only validated environment and expert operations', () => {
  const source = fs.readFileSync(path.resolve('src/api/v2/remoteConnections.js'), 'utf8')
  for (const operation of [
    'getEnvironmentReport',
    'getInitializationPlan',
    'initializeEnvironment',
    'verifyEnvironmentModels',
    'openExpertTunnel',
  ]) assert.match(source, new RegExp(`${operation}\\(`, 'u'))
  assert.match(source, /environmentReportView/u)
  assert.match(source, /initializationPlanView/u)
  assert.match(source, /initializationResultView/u)
  assert.doesNotMatch(source, /command|shell/u)
})

test('remote connection page mounts environment and expert modules and compiles', () => {
  const filename = path.resolve('src/views/RemoteConnections.vue')
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [])
  assert.doesNotThrow(() => compileScript(parsed.descriptor, { id: 'remote-connections-integrated' }))
  const compiled = compileTemplate({
    id: 'remote-connections-integrated',
    filename,
    source: parsed.descriptor.template.content,
  })
  assert.deepEqual(compiled.errors, [])
  assert.match(source, /RemoteEnvironmentPanel/u)
  assert.match(source, /RemoteExpertMode/u)
  assert.match(source, /checkEnvironment/u)
  assert.match(source, /openExpertTunnel/u)
  assert.match(source, /clearRuntimeState/u)
  assert.equal((source.match(/width="min\(560px, calc\(100vw - 32px\)\)"/gu) || []).length, 2)
  assert.equal((source.match(/width="min\(480px, calc\(100vw - 32px\)\)"/gu) || []).length, 1)
  assert.match(
    source,
    /async function load\(\)[\s\S]*?await closeAllExpertTunnels\(\)[\s\S]*?clearRuntimeState\(\)/u,
  )
})
