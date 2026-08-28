'use strict';

const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { createRemoteEnvironmentError } = require('./remoteEnvironmentErrors');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const WORKSPACE = /^[A-Za-z0-9._-]{1,96}(?:\/[A-Za-z0-9._-]{1,96}){0,15}$/u;
const PYTHON_RUNTIME = String.raw`
import base64, hashlib, importlib.metadata, json, os, platform, re, shutil, subprocess, sys, urllib.request
r=json.loads(base64.b64decode(sys.argv[1])); a=r['action']; p=r.get('parameters',{}); w=os.path.join(os.path.expanduser('~'),*r['workspace'].split('/')); port=r['comfyPort']
def run(args):
  try: return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5,check=False).stdout.strip()
  except Exception: return ''
def marker(name):
  try: return open(os.path.join(w,'.local-mini-drama',name),encoding='utf-8').read().strip()
  except Exception: return ''
def torch_values():
  try:
    import torch
    return importlib.metadata.version('torch').split('+')[0], (torch.version.cuda or '')
  except Exception: return None,None
def ffmpeg_version():
  m=re.search(r'ffmpeg version ([0-9]+(?:\.[0-9]+){1,2})',run(['ffmpeg','-version']))
  return m.group(1) if m else None
def probe():
  gpu=run(['nvidia-smi','--query-gpu=memory.total','--format=csv,noheader,nounits'])
  memories=[int(x.strip()) for x in gpu.splitlines() if x.strip().isdigit()]
  memory=0
  try:
    for line in open('/proc/meminfo',encoding='ascii'):
      if line.startswith('MemTotal:'): memory=int(line.split()[1])//1024; break
  except Exception: memory=1
  disk=shutil.disk_usage(w if os.path.isdir(w) else os.path.expanduser('~')).free//1048576
  tv,cv=torch_values(); arch={'x86_64':'x64','AMD64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine(),platform.machine())
  dirs=['input','output','workflows','models','jobs']
  reachable=False
  try:
    with urllib.request.urlopen('http://127.0.0.1:%d/system_stats'%port,timeout=2) as response: reachable=200 <= response.status < 300
  except Exception: pass
  return {'platform':'linux' if sys.platform.startswith('linux') else sys.platform,'architecture':arch,'gpuVendor':'nvidia' if memories else 'none','gpuCount':len(memories),'totalVramMiB':sum(memories),'systemMemoryMiB':max(1,memory),'diskFreeMiB':disk,'pythonVersion':platform.python_version(),'torchVersion':tv,'cudaVersion':cv,'ffmpegVersion':ffmpeg_version(),'comfyUiVersion':marker('comfyui-version') or None,'workspaceWritable':os.path.isdir(w) and os.access(w,os.W_OK),'directoriesReady':all(os.path.isdir(os.path.join(w,x)) for x in dirs),'comfyUiReachable':reachable}
changed=False
if a=='probe': out=probe()
elif a=='ensure-workspace-layout':
  before=os.path.isdir(w) and all(os.path.isdir(os.path.join(w,x)) for x in ['input','output','workflows','models','jobs','.local-mini-drama'])
  for x in ['input','output','workflows','models','jobs','.local-mini-drama']: os.makedirs(os.path.join(w,x),exist_ok=True)
  if not os.access(w,os.W_OK): raise RuntimeError('workspace')
  out={'changed':not before}
elif a=='ensure-python-runtime':
  tv,cv=torch_values()
  if not platform.python_version().startswith(p['pythonVersion']+'.') or tv!=p['torchVersion'] or cv!=p['cudaVersion']: raise RuntimeError('python')
  out={'changed':False}
elif a=='ensure-comfyui-version':
  if marker('comfyui-version')!=p['comfyUiVersion']: raise RuntimeError('comfy')
  out={'changed':False}
elif a=='ensure-custom-nodes':
  if marker('custom-node-lock')!=p['lockVersion']: raise RuntimeError('nodes')
  out={'changed':False}
elif a=='verify-ffmpeg':
  fv=ffmpeg_version()
  if not fv or int(fv.split('.')[0])<p['minimumMajor']: raise RuntimeError('ffmpeg')
  out={'changed':False}
elif a=='install-bundled-workflows':
  if marker('workflow-bundle-version')!=p['bundleVersion']: raise RuntimeError('workflows')
  out={'changed':False}
elif a=='verify-environment': out={'changed':False}
elif a=='install-model':
  f=os.path.join(w,'models',p['modelId'],p['version'],'artifact.bin')
  if not os.path.isfile(f) or os.path.getsize(f)!=p['sizeBytes']: raise RuntimeError('model')
  h=hashlib.sha256()
  with open(f,'rb') as stream:
    for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk)
  if h.hexdigest()!=p['artifactSha256']: raise RuntimeError('model')
  out={'changed':False}
else: raise RuntimeError('action')
print(json.dumps(out,separators=(',',':'),ensure_ascii=False))
`.trim();
const PYTHON_RUNTIME_BASE64 = Buffer.from(PYTHON_RUNTIME, 'utf8').toString('base64');
const sessionContexts = new WeakMap();

function fixedError(code) {
  return createRemoteEnvironmentError(code);
}

function readConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('SSH environment adapter configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['sessionService', 'timeoutMs']);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('SSH environment adapter configuration is invalid');
  }
  const service = descriptors.sessionService?.value;
  const timeoutMs = descriptors.timeoutMs?.value ?? DEFAULT_TIMEOUT_MS;
  const openSession = service && Object.getOwnPropertyDescriptor(service, 'openSession')?.value;
  if (typeof openSession !== 'function' || isProxy(openSession)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('SSH environment adapter configuration is invalid');
  }
  return Object.freeze({ service, openSession, timeoutMs });
}

function exactOpenedSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw fixedError('REMOTE_ENVIRONMENT_SESSION_FAILED');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const connection = descriptors.connection?.value;
  const session = descriptors.session?.value;
  if (!connection || !session || typeof connection !== 'object' || typeof session !== 'object'
    || isProxy(connection) || isProxy(session)) throw fixedError('REMOTE_ENVIRONMENT_SESSION_FAILED');
  const remoteWorkDir = Object.getOwnPropertyDescriptor(connection, 'remoteWorkDir')?.value;
  const comfyPort = Object.getOwnPropertyDescriptor(connection, 'comfyPort')?.value;
  const exec = Object.getOwnPropertyDescriptor(session, 'exec')?.value;
  const close = Object.getOwnPropertyDescriptor(session, 'close')?.value;
  if (typeof remoteWorkDir !== 'string' || !WORKSPACE.test(remoteWorkDir)
    || !Number.isInteger(comfyPort) || comfyPort < 1 || comfyPort > 65535
    || typeof exec !== 'function' || isProxy(exec) || typeof close !== 'function' || isProxy(close)) {
    throw fixedError('REMOTE_ENVIRONMENT_SESSION_FAILED');
  }
  return Object.freeze({ session, exec, close, remoteWorkDir, comfyPort });
}

function readOutput(stream, timeoutMs) {
  let outputBytes = 0;
  const chunks = [];
  const pending = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      stream.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
        outputBytes += bytes.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          stream.destroy?.();
          finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
          return;
        }
        chunks.push(bytes);
      });
      stream.stderr?.on?.('data', () => {});
      stream.once('error', () => finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED')));
      stream.once('close', (code) => {
        if (code !== 0) finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
        else finish(resolve, Buffer.concat(chunks).toString('utf8').trim());
      });
    } catch {
      finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
    }
  });
  return raceNativePromise(pending, {
    timeoutMs,
    onTimeout: () => stream.destroy?.(),
  });
}

async function execute(sessionFacade, action, parameters, errorCode, timeoutMs) {
  const context = sessionContexts.get(sessionFacade);
  if (!context) throw fixedError(errorCode);
  const request = Object.freeze({
    action,
    workspace: context.remoteWorkDir,
    comfyPort: context.comfyPort,
    parameters,
  });
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const command = `python3 -c "import base64;exec(base64.b64decode('${PYTHON_RUNTIME_BASE64}'))" '${payload}'`;
  if (command.length > 8192) throw fixedError(errorCode);
  let stream;
  try {
    stream = await raceNativePromise(Reflect.apply(context.exec, context.session, [command]), {
      timeoutMs,
    });
  } catch {
    throw fixedError(errorCode);
  }
  let raw;
  try { raw = await readOutput(stream, timeoutMs); } catch { throw fixedError(errorCode); }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (JSON.stringify(parsed) !== raw) throw new TypeError('non-canonical response');
  } catch {
    throw fixedError(errorCode);
  }
  return parsed;
}

function createSshEnvironmentAdapter(options) {
  const { service, openSession, timeoutMs } = readConfiguration(options);
  const sessionService = Object.freeze({
    async openSession(connectionUid) {
      let opened;
      try {
        opened = exactOpenedSession(await raceNativePromise(
          Reflect.apply(openSession, service, [connectionUid]),
          { timeoutMs },
        ));
      } catch {
        throw fixedError('REMOTE_ENVIRONMENT_SESSION_FAILED');
      }
      const facade = Object.freeze({
        close: () => Reflect.apply(opened.close, opened.session, []),
      });
      sessionContexts.set(facade, opened);
      return Object.freeze({ session: facade });
    },
  });
  const probe = Object.freeze({
    inspect: (session) => execute(
      session,
      'probe',
      Object.freeze({}),
      'REMOTE_ENVIRONMENT_PROBE_FAILED',
      timeoutMs,
    ),
  });
  const action = (name) => (session, parameters) => execute(
    session,
    name,
    parameters,
    'REMOTE_ENVIRONMENT_INITIALIZATION_FAILED',
    timeoutMs,
  );
  const initializer = Object.freeze({
    ensureWorkspaceLayout: action('ensure-workspace-layout'),
    ensurePythonRuntime: action('ensure-python-runtime'),
    ensureComfyUiVersion: action('ensure-comfyui-version'),
    ensureCustomNodes: action('ensure-custom-nodes'),
    verifyFfmpeg: action('verify-ffmpeg'),
    installBundledWorkflows: action('install-bundled-workflows'),
    verifyEnvironment: action('verify-environment'),
    installModel: action('install-model'),
  });
  return Object.freeze({ initializer, probe, sessionService });
}

module.exports = Object.freeze({ createSshEnvironmentAdapter });
