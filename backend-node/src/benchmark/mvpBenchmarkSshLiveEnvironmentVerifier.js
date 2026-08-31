'use strict';

const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const { types: { isProxy } } = require('node:util');

const { raceNativePromise } = require('../integrations/comfyui/asyncControl');
const { snapshotBuffer } = require('../integrations/comfyui/byteSnapshot');
const {
  createRemoteConnectionRecord,
  remoteConnectionEvidenceSha256,
} = require('../remote/connectionProfile');
const {
  APPROVED_LIVE_ENVIRONMENT,
  MvpBenchmarkExecutionPreflightError,
  createMvpBenchmarkLiveEnvironmentObservation,
} = require('./mvpBenchmarkExecutionPreflight');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_CONCAT = Buffer.concat;
const EVENT_ON = EventEmitter.prototype.on;
const DUPLEX_DESTROY = Duplex.prototype.destroy;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MODEL_DIRECTORIES = Object.freeze({
  'fl2va-diffusion': 'diffusion_models',
  'ref2va-diffusion': 'diffusion_models',
  'text-encoder': 'text_encoders',
  'video-vae': 'vae',
  'audio-vae': 'vae',
  'fl2va-turbo-lora': 'loras',
  'ref2va-turbo-lora': 'loras',
});

const PROBE_RUNTIME = String.raw`
import base64,hashlib,importlib.metadata,json,os,platform,re,stat,subprocess,sys
p=json.loads(base64.b64decode(sys.argv[1])); root=os.path.join(os.path.expanduser('~'),'ComfyUI')
def run(args,timeout=15):
  result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=timeout,check=False)
  if result.returncode!=0: raise RuntimeError('probe')
  return result.stdout.strip()
def stable_model(spec):
  path=os.path.join(root,*spec['relativePath'].split('/')); before=os.stat(path,follow_symlinks=True)
  if not stat.S_ISREG(before.st_mode): raise RuntimeError('model')
  fd=os.open(path,os.O_RDONLY|getattr(os,'O_CLOEXEC',0)); digest=hashlib.sha256()
  try:
    opened=os.fstat(fd)
    if (before.st_dev,before.st_ino,before.st_mode,before.st_nlink,before.st_size,before.st_ctime_ns,before.st_mtime_ns)!=(opened.st_dev,opened.st_ino,opened.st_mode,opened.st_nlink,opened.st_size,opened.st_ctime_ns,opened.st_mtime_ns): raise RuntimeError('model')
    while True:
      chunk=os.read(fd,1048576)
      if not chunk: break
      digest.update(chunk)
    after_read=os.fstat(fd)
  finally: os.close(fd)
  after=os.stat(path,follow_symlinks=True)
  signature=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_nlink,value.st_size,value.st_ctime_ns,value.st_mtime_ns)
  if signature(before)!=signature(after_read) or signature(before)!=signature(after): raise RuntimeError('model')
  return {'role':spec['role'],'fileName':spec['fileName'],'sha256':digest.hexdigest(),'bytes':before.st_size}
def listen_scope(port):
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
gpu_lines=[line.strip() for line in run(['nvidia-smi','--query-gpu=name,memory.total,driver_version','--format=csv,noheader,nounits']).splitlines() if line.strip()]
if len(gpu_lines)!=1: raise RuntimeError('gpu')
gpu_parts=[part.strip() for part in gpu_lines[0].split(',')]
if len(gpu_parts)!=3: raise RuntimeError('gpu')
revision=run(['git','-C',root,'rev-parse','HEAD']); tag=run(['git','-C',root,'describe','--tags','--exact-match','HEAD'])
if not re.fullmatch(r'v[0-9]+(?:\.[0-9]+){2}',tag): raise RuntimeError('comfy')
ffmpeg=run(['ffmpeg','-version']).splitlines()[0]; match=re.search(r'ffmpeg version ([0-9]+(?:\.[0-9]+){1,2})',ffmpeg)
if not match: raise RuntimeError('ffmpeg')
models=[stable_model(spec) for spec in p['models']]
out={'gpu':{'gpuClass':'rtx4090-24gb','name':gpu_parts[0],'vramMiB':int(gpu_parts[1]),'driverVersion':gpu_parts[2]},'comfyUI':{'version':tag[1:],'revision':revision,'listenScope':listen_scope(p['comfyPort'])},'runtime':{'pythonVersion':platform.python_version(),'pytorchVersion':importlib.metadata.version('torch'),'ffmpegVersion':match.group(1)},'models':models}
print(json.dumps(out,separators=(',',':'),ensure_ascii=False))
`.trim();
const PROBE_RUNTIME_BASE64 = zlib.deflateRawSync(
  Buffer.from(PROBE_RUNTIME, 'utf8'),
).toString('base64');

function fail() {
  throw new MvpBenchmarkExecutionPreflightError(
    'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE',
  );
}

function exactConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark SSH verifier configuration is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(['sessionService', 'nowEpochMs', 'timeoutMs']);
  if (Reflect.ownKeys(descriptors).some(
    (key) => typeof key !== 'string' || !allowed.has(key),
  )) throw new TypeError('MVP benchmark SSH verifier configuration is invalid');
  const sessionService = descriptors.sessionService?.value;
  const openSession = sessionService
    && Object.getOwnPropertyDescriptor(sessionService, 'openSession')?.value;
  const nowEpochMs = descriptors.nowEpochMs?.value ?? Date.now;
  const timeoutMs = descriptors.timeoutMs?.value ?? DEFAULT_TIMEOUT_MS;
  if (!sessionService || typeof openSession !== 'function' || isProxy(openSession)
    || typeof nowEpochMs !== 'function' || isProxy(nowEpochMs)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new TypeError('MVP benchmark SSH verifier configuration is invalid');
  }
  return Object.freeze({ sessionService, openSession, nowEpochMs, timeoutMs });
}

function exactInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
  const keys = [
    'authorizationUid', 'sessionUid', 'connectionUid', 'connectionEvidenceSha256',
    'approvedEnvironmentSha256',
  ];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) fail();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[keys[index]] = descriptor.value;
  }
  if (!UUID_V4.test(output.authorizationUid) || !UUID_V4.test(output.sessionUid)
    || !UUID_V4.test(output.connectionUid)
    || !SHA256.test(output.connectionEvidenceSha256)
    || !SHA256.test(output.approvedEnvironmentSha256)) fail();
  return output;
}

function openedSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return fail(); }
  if (Reflect.ownKeys(descriptors).length !== 2) fail();
  const connection = descriptors.connection?.value;
  const session = descriptors.session?.value;
  const exec = session && Object.getOwnPropertyDescriptor(session, 'exec')?.value;
  const close = session && Object.getOwnPropertyDescriptor(session, 'close')?.value;
  if (!connection || !session || typeof connection !== 'object' || typeof session !== 'object'
    || isProxy(connection) || isProxy(session) || typeof exec !== 'function' || isProxy(exec)
    || typeof close !== 'function' || isProxy(close)) fail();
  return Object.freeze({ connection, session, exec, close });
}

function modelProbeSpecs() {
  const output = [];
  for (let index = 0; index < APPROVED_LIVE_ENVIRONMENT.models.length; index += 1) {
    const model = APPROVED_LIVE_ENVIRONMENT.models[index];
    const directory = MODEL_DIRECTORIES[model.role];
    if (!directory) fail();
    Object.defineProperty(output, String(index), {
      configurable: true,
      enumerable: true,
      value: Object.freeze({
        role: model.role,
        fileName: model.fileName,
        relativePath: `models/${directory}/${model.fileName}`,
      }),
      writable: true,
    });
  }
  return Object.freeze(output);
}

function commandFor(comfyPort) {
  if (!Number.isSafeInteger(comfyPort) || comfyPort < 1 || comfyPort > 65535) fail();
  const payload = Buffer.from(JSON.stringify({
    comfyPort,
    models: modelProbeSpecs(),
  }), 'utf8').toString('base64');
  const command = `python3 -c "import base64,zlib;exec(zlib.decompress(base64.b64decode('${PROBE_RUNTIME_BASE64}'),-15))" '${payload}'`;
  if (command.length > 8192) fail();
  return command;
}

function destroyStream(stream) {
  if (!stream || typeof stream !== 'object' || isProxy(stream)) return;
  try { Reflect.apply(DUPLEX_DESTROY, stream, []); } catch { /* bounded cleanup */ }
}

function readOutput(stream, timeoutMs) {
  if (!stream || typeof stream !== 'object' || isProxy(stream)) return fail();
  let stderr;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'stderr');
    stderr = descriptor?.value;
  } catch {
    return fail();
  }
  if (!stderr || typeof stderr !== 'object' || isProxy(stderr)) return fail();
  const pending = new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const chunks = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const acceptChunk = (chunk, collect) => {
      if (settled) return;
      let snapshot;
      try {
        snapshot = snapshotBuffer(
          chunk,
          MAX_OUTPUT_BYTES,
          () => new TypeError('invalid SSH probe output'),
        );
      } catch {
        destroyStream(stream);
        finish(reject, new TypeError('invalid SSH probe output'));
        return;
      }
      outputBytes += Reflect.apply(BUFFER_BYTE_LENGTH, Buffer, [snapshot]);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        destroyStream(stream);
        finish(reject, new TypeError('oversized SSH probe output'));
        return;
      }
      if (collect) {
        Object.defineProperty(chunks, String(chunks.length), {
          configurable: true, enumerable: true, value: snapshot, writable: true,
        });
      }
    };
    const rejectStream = () => {
      destroyStream(stream);
      finish(reject, new TypeError('SSH probe failed'));
    };
    try {
      Reflect.apply(EVENT_ON, stream, ['data', (chunk) => {
        acceptChunk(chunk, true);
      }]);
      Reflect.apply(EVENT_ON, stderr, ['data', (chunk) => { acceptChunk(chunk, false); }]);
      Reflect.apply(EVENT_ON, stderr, ['error', rejectStream]);
      Reflect.apply(EVENT_ON, stream, ['error', rejectStream]);
      Reflect.apply(EVENT_ON, stream, ['close', (code) => {
        if (code !== 0) finish(reject, new TypeError('SSH probe failed'));
        else finish(resolve, Reflect.apply(BUFFER_CONCAT, Buffer, [chunks]).toString('utf8').trim());
      }]);
    } catch {
      rejectStream();
    }
  });
  return raceNativePromise(pending, {
    timeoutMs,
    onTimeout: () => {
      destroyStream(stream);
    },
  });
}

async function closeSession(opened, timeoutMs) {
  let result;
  try { result = Reflect.apply(opened.close, opened.session, []); } catch { return fail(); }
  if (result === undefined) return;
  try { await raceNativePromise(result, { timeoutMs }); } catch { return fail(); }
}

async function closeLateOpenedSession(pending, state, timeoutMs) {
  try {
    const candidate = await raceNativePromise(pending);
    if (!state.abandoned) return;
    await closeSession(openedSession(candidate), timeoutMs);
  } catch { /* the primary operation reports the fixed failure */ }
}

async function destroyLateStream(pending, state) {
  try {
    const stream = await raceNativePromise(pending);
    if (state.abandoned) destroyStream(stream);
  } catch { /* the primary operation reports the fixed failure */ }
}

function createMvpBenchmarkSshLiveEnvironmentVerifier(value) {
  const configured = exactConfiguration(value);

  async function inspect(request) {
    const input = exactInput(request);
    let opened;
    let operationError = null;
    let result;
    try {
      const pending = Reflect.apply(
        configured.openSession,
        configured.sessionService,
        [input.connectionUid, input.connectionEvidenceSha256],
      );
      const openState = { abandoned: false };
      void closeLateOpenedSession(pending, openState, configured.timeoutMs);
      opened = openedSession(await raceNativePromise(
        pending,
        {
          timeoutMs: configured.timeoutMs,
          onTimeout: () => { openState.abandoned = true; },
        },
      ));
      let connection;
      try { connection = createRemoteConnectionRecord(opened.connection); } catch {
        return fail();
      }
      let evidence;
      try { evidence = remoteConnectionEvidenceSha256(connection); } catch {
        return fail();
      }
      if (connection.uid !== input.connectionUid
        || evidence !== input.connectionEvidenceSha256) fail();
      const execPending = Reflect.apply(
        opened.exec, opened.session, [commandFor(connection.comfyPort)],
      );
      const execState = { abandoned: false };
      void destroyLateStream(execPending, execState);
      const stream = await raceNativePromise(execPending, {
        timeoutMs: configured.timeoutMs,
        onTimeout: () => { execState.abandoned = true; },
      });
      const raw = await readOutput(stream, configured.timeoutMs);
      let parsed;
      try {
        parsed = JSON.parse(raw);
        if (JSON.stringify(parsed) !== raw) throw new TypeError('non-canonical response');
      } catch {
        return fail();
      }
      let observedAtEpochMs;
      try { observedAtEpochMs = Reflect.apply(configured.nowEpochMs, undefined, []); } catch {
        return fail();
      }
      const validated = createMvpBenchmarkLiveEnvironmentObservation({
        schemaVersion: 'mvp-benchmark-live-environment-observation.v1',
        connectionUid: input.connectionUid,
        connectionEvidenceSha256: input.connectionEvidenceSha256,
        observedAtEpochMs,
        approvedEnvironmentSha256: input.approvedEnvironmentSha256,
        gpu: parsed.gpu,
        comfyUI: parsed.comfyUI,
        runtime: parsed.runtime,
        models: parsed.models,
      });
      result = Object.freeze({
        schemaVersion: validated.schemaVersion,
        connectionUid: validated.connectionUid,
        connectionEvidenceSha256: validated.connectionEvidenceSha256,
        observedAtEpochMs: validated.observedAtEpochMs,
        approvedEnvironmentSha256: validated.approvedEnvironmentSha256,
        gpu: validated.gpu,
        comfyUI: validated.comfyUI,
        runtime: validated.runtime,
        models: validated.models,
      });
    } catch (error) {
      operationError = error;
    }
    if (opened) {
      try { await closeSession(opened, configured.timeoutMs); } catch (error) {
        operationError = error;
      }
    }
    if (operationError || !result) fail();
    return result;
  }

  return Object.freeze({ inspect });
}

module.exports = Object.freeze({ createMvpBenchmarkSshLiveEnvironmentVerifier });
