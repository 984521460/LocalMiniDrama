'use strict';

const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { snapshotBuffer } = require('../integrations/comfyui/byteSnapshot');
const { createH3TextToVideoWorkflowBundle } = require('../h3/workflowBundle');
const { createRemoteEnvironmentError } = require('./remoteEnvironmentErrors');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_CONCAT = Buffer.concat;
const EVENT_ON = EventEmitter.prototype.on;
const DUPLEX_DESTROY = Duplex.prototype.destroy;
const WORKSPACE = /^[A-Za-z0-9._-]{1,96}(?:\/[A-Za-z0-9._-]{1,96}){0,15}$/u;
const workflowBundle = createH3TextToVideoWorkflowBundle();
const requiredNodeTypes = Object.freeze([
  ...new Set(workflowBundle.manifest.requirements
    .filter((requirement) => requirement.kind === 'node')
    .map((requirement) => requirement.nodeType)),
].sort());
const ACTION_CONTEXT = Object.freeze({
  requiredNodeTypes,
  workflow: Object.freeze({
    relativePath: 'workflows/v7/minimax-h3-t2v-api.json',
    sha256: workflowBundle.manifest.workflowSha256,
    bytes: Buffer.byteLength(workflowBundle.workflowJson, 'utf8'),
    base64: Buffer.from(workflowBundle.workflowJson, 'utf8').toString('base64'),
  }),
});
const PYTHON_RUNTIME = String.raw`
import base64,hashlib,importlib.metadata,json,os,platform,re,shutil,signal,stat,subprocess,sys,time,urllib.request,zlib
r=json.loads(zlib.decompress(base64.b64decode(sys.argv[1]),-15)); a=r['action']; p=r.get('parameters',{}); x=r['context']; home=os.path.expanduser('~'); w=os.path.join(home,*r['workspace'].split('/')); root=os.path.join(home,'ComfyUI'); port=r['comfyPort']
def directory(path):
  value=os.lstat(path)
  if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode): raise RuntimeError('directory')
  return value
def directory_tree(base,parts,create=False):
  directory(base); current=base
  for part in parts:
    current=os.path.join(current,part)
    try: directory(current)
    except FileNotFoundError:
      if not create: raise
      os.mkdir(current,0o700); directory(current)
  return current
def workspace(create=False): return directory_tree(home,r['workspace'].split('/'),create)
def workspace_ready():
  try:
    current=workspace(False)
    for name in ['input','output','workflows','models','jobs','.local-mini-drama']: directory(os.path.join(current,name))
    return True
  except Exception: return False
def run(args,timeout=15):
  result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=timeout,check=False)
  if result.returncode!=0: raise RuntimeError('command')
  return result.stdout.strip()
def torch_values():
  try:
    import torch
    return importlib.metadata.version('torch'),(torch.version.cuda or '')
  except Exception: return None,None
def ffmpeg_version():
  try: value=run(['ffmpeg','-version']).splitlines()[0]
  except Exception: return None
  match=re.search(r'ffmpeg version ([0-9]+(?:\.[0-9]+){1,2})',value)
  return match.group(1) if match else None
def git_revision():
  try:
    revision=run(['git','-C',root,'rev-parse','HEAD'])
    if run(['git','-C',root,'status','--porcelain=v1','--untracked-files=all']): return None
    return revision
  except Exception: return None
def bounded_json(url,limit):
  with urllib.request.urlopen(url,timeout=5) as response:
    if not 200<=response.status<300: raise RuntimeError('http')
    data=response.read(limit+1)
  if len(data)>limit: raise RuntimeError('http')
  return json.loads(data.decode('utf-8'))
def comfy_stats():
  value=bounded_json('http://127.0.0.1:%d/system_stats'%port,65536)
  version=value.get('system',{}).get('comfyui_version')
  if not isinstance(version,str): raise RuntimeError('comfy')
  return value,version
def listen_scope():
  addresses=[]; wanted='%04X'%port
  for source in ['/proc/net/tcp','/proc/net/tcp6']:
    try:
      with open(source,encoding='ascii') as stream:
        for line in stream:
          fields=line.split()
          if len(fields)>3 and fields[3]=='0A':
            address,found_port=fields[1].split(':')
            if found_port.upper()==wanted: addresses.append(address.upper())
    except FileNotFoundError: pass
  allowed={'0100007F','00000000000000000000000001000000'}
  if not addresses or any(address not in allowed for address in addresses): raise RuntimeError('listen')
  return 'loopback'
def required_nodes():
  nodes=bounded_json('http://127.0.0.1:%d/object_info'%port,8388608)
  if any(name not in nodes for name in x['requiredNodeTypes']): raise RuntimeError('nodes')
def stop_owned_comfy(process):
  try:
    if process.poll() is None:
      os.killpg(process.pid,signal.SIGTERM); process.wait(timeout=5)
  except Exception:
    try:
      if process.poll() is None: os.killpg(process.pid,signal.SIGKILL); process.wait(timeout=5)
    except Exception: pass
def start_comfy():
  try:
    _,version=comfy_stats(); return False,version,None
  except Exception: pass
  if not os.path.isfile(os.path.join(root,'main.py')): raise RuntimeError('comfy')
  logs=directory_tree(workspace(False),['.local-mini-drama'],False)
  log_path=os.path.join(logs,'comfyui.log')
  flags=os.O_WRONLY|os.O_CREAT|os.O_APPEND|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0)
  fd=os.open(log_path,flags,0o600); opened_log=os.fstat(fd)
  if not stat.S_ISREG(opened_log.st_mode) or opened_log.st_nlink!=1:
    os.close(fd); raise RuntimeError('log')
  log=os.fdopen(fd,'ab',buffering=0)
  try:
    process=subprocess.Popen([sys.executable,os.path.join(root,'main.py'),'--listen','127.0.0.1','--port',str(port)],cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
  finally: log.close()
  try:
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
      if process.poll() is not None: raise RuntimeError('comfy')
      try:
        _,version=comfy_stats(); return True,version,process
      except Exception: time.sleep(1)
    raise RuntimeError('comfy')
  except BaseException:
    stop_owned_comfy(process); raise
def stable_file(path,size,digest):
  before=os.lstat(path)
  if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size!=size: raise RuntimeError('file')
  fd=os.open(path,os.O_RDONLY|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0)); measured=hashlib.sha256()
  try:
    opened=os.fstat(fd)
    signature=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_nlink,value.st_size,value.st_ctime_ns,value.st_mtime_ns)
    if signature(before)!=signature(opened): raise RuntimeError('file')
    while True:
      chunk=os.read(fd,1048576)
      if not chunk: break
      measured.update(chunk)
    after_read=os.fstat(fd)
  finally: os.close(fd)
  after=os.lstat(path)
  if signature(before)!=signature(after_read) or signature(before)!=signature(after) or measured.hexdigest()!=digest: raise RuntimeError('file')
def install_workflow(spec):
  data=base64.b64decode(spec['base64'],validate=True)
  if len(data)!=spec['bytes'] or hashlib.sha256(data).hexdigest()!=spec['sha256']: raise RuntimeError('workflow')
  parent=directory_tree(workspace(False),spec['relativePath'].split('/')[:-1],True)
  path=os.path.join(parent,spec['relativePath'].split('/')[-1])
  if os.path.lexists(path): stable_file(path,spec['bytes'],spec['sha256']); return False
  temporary=path+'.pending-%d'%os.getpid()
  try:
    with open(temporary,'xb') as stream: stream.write(data); stream.flush(); os.fsync(stream.fileno())
    os.link(temporary,path)
    stable_file(path,spec['bytes'],spec['sha256'])
  finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
  return True
def probe():
  try: gpu=run(['nvidia-smi','--query-gpu=name,memory.total,driver_version','--format=csv,noheader,nounits'])
  except Exception: gpu=''
  rows=[line.strip() for line in gpu.splitlines() if line.strip()]; names=[]; memories=[]; drivers=[]
  for row in rows:
    parts=[part.strip() for part in row.split(',')]
    if len(parts)==3 and parts[1].isdigit(): names.append(parts[0]); memories.append(int(parts[1])); drivers.append(parts[2])
  memory=0
  try:
    for line in open('/proc/meminfo',encoding='ascii'):
      if line.startswith('MemTotal:'): memory=int(line.split()[1])//1024; break
  except Exception: memory=1
  ready=workspace_ready(); current_workspace=workspace(False) if ready else home
  disk=shutil.disk_usage(current_workspace).free//1048576
  tv,cv=torch_values(); arch={'x86_64':'x64','AMD64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine(),platform.machine()); version=None; reachable=False
  dirs=['input','output','workflows','models','jobs']
  try:
    _,version=comfy_stats(); listen_scope(); reachable=True
  except Exception: pass
  return {'platform':'linux' if sys.platform.startswith('linux') else sys.platform,'architecture':arch,'gpuVendor':'nvidia' if memories else 'none','gpuName':names[0] if len(names)==1 else '', 'gpuCount':len(memories),'totalVramMiB':sum(memories),'driverVersion':drivers[0] if len(drivers)==1 else None,'systemMemoryMiB':max(1,memory),'diskFreeMiB':disk,'pythonVersion':platform.python_version(),'torchVersion':tv,'cudaVersion':cv,'ffmpegVersion':ffmpeg_version(),'comfyUiVersion':version,'comfyUiRevision':git_revision(),'workspaceWritable':ready and os.access(current_workspace,os.W_OK),'directoriesReady':ready and all(os.path.isdir(os.path.join(current_workspace,x)) for x in dirs),'comfyUiReachable':reachable}
changed=False
if a=='probe': out=probe()
elif a=='ensure-workspace-layout':
  before=workspace_ready(); current_workspace=workspace(True)
  for x in ['input','output','workflows','models','jobs','.local-mini-drama']: directory_tree(current_workspace,[x],True)
  if not os.access(current_workspace,os.W_OK): raise RuntimeError('workspace')
  out={'changed':not before}
elif a=='verify-python-runtime':
  tv,cv=torch_values()
  if platform.python_version()!=p['pythonVersion'] or tv!=p['torchVersion'] or cv!=p['cudaVersion']: raise RuntimeError('python')
  out={'changed':False}
elif a=='ensure-comfyui-service':
  if git_revision()!=p['comfyUiRevision'] or p['listenScope']!='loopback': raise RuntimeError('comfy')
  changed,version,owned=start_comfy()
  try:
    if version!=p['comfyUiVersion'] or listen_scope()!='loopback': raise RuntimeError('comfy')
    required_nodes()
  except BaseException:
    if owned is not None: stop_owned_comfy(owned)
    raise
  out={'changed':changed}
elif a=='verify-custom-nodes':
  required_nodes()
  out={'changed':False}
elif a=='verify-ffmpeg':
  fv=ffmpeg_version()
  if fv!=p['ffmpegVersion']: raise RuntimeError('ffmpeg')
  out={'changed':False}
elif a=='install-bundled-workflows':
  out={'changed':install_workflow(x['workflow'])}
elif a=='verify-environment':
  current=probe()
  if not current['workspaceWritable'] or not current['directoriesReady'] or not current['comfyUiReachable']: raise RuntimeError('environment')
  out={'changed':False}
elif a=='verify-model':
  relative=p['relativePath']
  if not re.fullmatch(r'models/(?:diffusion_models|text_encoders|vae|loras)/[A-Za-z0-9._-]{1,160}',relative): raise RuntimeError('model')
  f=os.path.join(root,*relative.split('/'))
  stable_file(f,p['sizeBytes'],p['artifactSha256'])
  out={'changed':False}
else: raise RuntimeError('action')
print(json.dumps(out,separators=(',',':'),ensure_ascii=False))
`.trim();
const PYTHON_RUNTIME_BASE64 = zlib.deflateRawSync(
  Buffer.from(PYTHON_RUNTIME, 'utf8'),
).toString('base64');
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
  if (!stream || typeof stream !== 'object' || isProxy(stream)) {
    throw fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED');
  }
  let stderr;
  try { stderr = Object.getOwnPropertyDescriptor(stream, 'stderr')?.value; } catch {
    throw fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED');
  }
  if (!stderr || typeof stderr !== 'object' || isProxy(stderr)) {
    throw fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED');
  }
  let outputBytes = 0;
  const chunks = [];
  const pending = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const destroy = () => {
      try { Reflect.apply(DUPLEX_DESTROY, stream, []); } catch { /* bounded cleanup */ }
    };
    const acceptChunk = (chunk, collect) => {
      if (settled) return;
      let bytes;
      try {
        bytes = snapshotBuffer(
          chunk,
          MAX_OUTPUT_BYTES,
          () => fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'),
        );
        outputBytes += Reflect.apply(BUFFER_BYTE_LENGTH, Buffer, [bytes]);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          destroy();
          finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
          return;
        }
        if (collect) Object.defineProperty(chunks, String(chunks.length), {
          configurable: true, enumerable: true, value: bytes, writable: true,
        });
      } catch {
        destroy();
        finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
      }
    };
    const rejectStream = () => {
      destroy();
      finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
    };
    try {
      Reflect.apply(EVENT_ON, stream, ['data', (chunk) => acceptChunk(chunk, true)]);
      Reflect.apply(EVENT_ON, stderr, ['data', (chunk) => acceptChunk(chunk, false)]);
      Reflect.apply(EVENT_ON, stderr, ['error', rejectStream]);
      Reflect.apply(EVENT_ON, stream, ['error', rejectStream]);
      Reflect.apply(EVENT_ON, stream, ['close', (code) => {
        if (code !== 0) finish(reject, fixedError('REMOTE_ENVIRONMENT_PROBE_FAILED'));
        else finish(resolve, Reflect.apply(BUFFER_CONCAT, Buffer, [chunks]).toString('utf8').trim());
      }]);
    } catch {
      rejectStream();
    }
  });
  return raceNativePromise(pending, {
    timeoutMs,
    onTimeout: () => {
      try { Reflect.apply(DUPLEX_DESTROY, stream, []); } catch { /* bounded cleanup */ }
    },
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
    context: ACTION_CONTEXT,
  });
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(request), 'utf8')).toString('base64');
  const command = `python3 -c "import base64,zlib;exec(zlib.decompress(base64.b64decode('${PYTHON_RUNTIME_BASE64}'),-15))" '${payload}'`;
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
    verifyPythonRuntime: action('verify-python-runtime'),
    ensureComfyUiService: action('ensure-comfyui-service'),
    verifyCustomNodes: action('verify-custom-nodes'),
    verifyFfmpeg: action('verify-ffmpeg'),
    installBundledWorkflows: action('install-bundled-workflows'),
    verifyEnvironment: action('verify-environment'),
    verifyModel: action('verify-model'),
  });
  return Object.freeze({ initializer, probe, sessionService });
}

module.exports = Object.freeze({ createSshEnvironmentAdapter });
