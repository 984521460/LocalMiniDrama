import childProcess from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(root, 'backend-node', 'native', 'log-directory-lease.cc')
const delayLoadSource = path.join(root, 'backend-node', 'native', 'win-delay-load-hook.cc')
const buildRoot = path.join(root, 'backend-node', 'native', 'build')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail('The secure log directory lease currently requires Windows x64')
}
if (!fs.existsSync(source) || !fs.existsSync(delayLoadSource)) {
  fail('Native log directory lease source is missing')
}

const vswhere = path.join(
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
)
if (!fs.existsSync(vswhere)) fail('Visual Studio Build Tools discovery is unavailable')

const installationPath = childProcess.execFileSync(vswhere, [
  '-latest',
  '-products',
  '*',
  '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property',
  'installationPath',
], { encoding: 'utf8', windowsHide: true }).trim()
if (!installationPath) fail('Visual Studio C++ Build Tools are unavailable')

const vsDevCmd = path.join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat')
const nodeCacheRoot = path.join(
  process.env.LOCALAPPDATA || '',
  'node-gyp',
  'Cache',
  process.versions.node,
)
const electronPackage = JSON.parse(fs.readFileSync(
  path.join(root, 'desktop', 'node_modules', 'electron', 'package.json'),
  'utf8',
))
const electronCacheRoot = path.join(
  process.env.USERPROFILE || '',
  '.electron-gyp',
  electronPackage.version,
)
const targets = Object.freeze([
  Object.freeze({
    name: `node-${process.platform}-${process.arch}`,
    includeDir: path.join(nodeCacheRoot, 'include', 'node'),
    libraryDir: path.join(nodeCacheRoot, 'x64'),
    loadWithHostNode: true,
  }),
  Object.freeze({
    name: `electron-${process.platform}-${process.arch}`,
    includeDir: path.join(electronCacheRoot, 'include', 'node'),
    libraryDir: path.join(electronCacheRoot, 'x64'),
    loadWithHostNode: false,
  }),
])
if (!fs.existsSync(vsDevCmd)) fail('Visual Studio developer environment is unavailable')
for (const target of targets) {
  if (!fs.existsSync(path.join(target.includeDir, 'node_api.h'))
      || !fs.existsSync(path.join(target.libraryDir, 'node.lib'))) {
    fail('Local Node or Electron headers and import libraries are unavailable')
  }
}

const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`
const require = createRequire(import.meta.url)

function buildTarget(target) {
  const buildDir = path.join(buildRoot, target.name)
  const output = path.join(buildDir, 'log-directory-lease.node')
  const responseFile = path.join(buildDir, 'compile.rsp')
  const delayLoadResponseFile = path.join(buildDir, 'compile-delay-load.rsp')
  const linkResponseFile = path.join(buildDir, 'link.rsp')
  const commandFile = path.join(buildDir, 'compile.cmd')
  fs.mkdirSync(buildDir, { recursive: true })

  const response = [
    '/nologo',
    '/std:c++17',
    '/EHsc',
    '/O2',
    '/c',
    '/DNAPI_VERSION=8',
    '/DNODE_GYP_MODULE_NAME=log_directory_lease',
    `/I${quote(target.includeDir)}`,
    `/Fo${quote('log-directory-lease.obj')}`,
    `/Fd${quote('log-directory-lease.pdb')}`,
    quote(path.relative(buildDir, source)),
  ].join(os.EOL)
  const linkResponse = [
    '/NOLOGO',
    '/DLL',
    '/MACHINE:X64',
    quote('log-directory-lease.obj'),
    quote('win-delay-load-hook.obj'),
    `/OUT:${quote('log-directory-lease.node')}`,
    `/PDB:${quote('log-directory-lease-link.pdb')}`,
    `/IMPLIB:${quote('log-directory-lease.lib')}`,
    `/LIBPATH:${quote(target.libraryDir)}`,
    '/DELAYLOAD:node.exe',
    'node.lib',
    'delayimp.lib',
  ].join(os.EOL)
  const delayLoadResponse = [
    '/nologo',
    '/std:c++17',
    '/EHsc',
    '/O2',
    '/c',
    `/Fo${quote('win-delay-load-hook.obj')}`,
    `/Fd${quote('win-delay-load-hook.pdb')}`,
    quote(path.relative(buildDir, delayLoadSource)),
  ].join(os.EOL)
  fs.writeFileSync(responseFile, response, 'utf8')
  fs.writeFileSync(delayLoadResponseFile, delayLoadResponse, 'utf8')
  fs.writeFileSync(linkResponseFile, linkResponse, 'utf8')

  const command = [
    '@echo off',
    `call "${vsDevCmd}" -arch=x64 -host_arch=x64 >nul`,
    'if errorlevel 1 exit /b %errorlevel%',
    'cl.exe @compile.rsp',
    'if errorlevel 1 exit /b %errorlevel%',
    'cl.exe @compile-delay-load.rsp',
    'if errorlevel 1 exit /b %errorlevel%',
    'link.exe @link.rsp',
    'exit /b %errorlevel%',
  ].join('\r\n')
  fs.writeFileSync(commandFile, `${command}\r\n`, 'utf8')
  const result = childProcess.spawnSync('cmd.exe', ['/d', '/c', commandFile], {
    cwd: buildDir,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    fail(`Native log directory lease compilation failed for ${target.name}`)
  }
  if (!fs.existsSync(output) || fs.statSync(output).size < 1) {
    fail(`Compiled native log directory lease is missing for ${target.name}`)
  }

  if (target.loadWithHostNode) {
    let addon
    try {
      addon = require(output)
    } catch (_) {
      fail('Compiled native log directory lease could not be loaded by Node')
    }
    if (typeof addon?.acquireDirectoryLease !== 'function'
        || typeof addon?.appendBoundedLog !== 'function'
        || typeof addon?.releaseDirectoryLease !== 'function') {
      fail('Compiled native log directory lease exports are invalid')
    }
  }
  process.stdout.write(`Built ${path.relative(root, output).replaceAll('\\', '/')}\n`)
}

for (const target of targets) buildTarget(target)
