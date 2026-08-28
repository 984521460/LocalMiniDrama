'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileComfyWorkflow } = require('../src/integrations/comfyui/workflowCompiler');
const { convertComfyApiWorkflow } = require('../src/integrations/comfyui/workflowConverter');
const {
  ComfyWorkflowError,
  createComfyWorkflowError,
  isComfyWorkflowError,
} = require('../src/integrations/comfyui/workflowErrors');
const { loadComfyWorkflowJson } = require('../src/integrations/comfyui/workflowLoader');

function workflowFixture() {
  return {
    10: {
      class_type: 'PromptNode',
      inputs: { text: 'old prompt', width: 64, height: 64 },
      _meta: { title: 'APP_GENERATION_INPUTS' },
    },
    20: {
      class_type: 'SaveVideo',
      inputs: { video: ['10', 0], filename_prefix: 'jobs/default' },
      _meta: { title: 'APP_OUTPUT_VIDEO' },
    },
  };
}

function compilerInput(workflow = workflowFixture()) {
  return {
    convertedWorkflow: convertComfyApiWorkflow(workflow),
    inputBindings: {
      prompt: {
        marker: 'APP_GENERATION_INPUTS', inputName: 'text', valueType: 'string', required: true,
      },
      width: {
        marker: 'APP_GENERATION_INPUTS', inputName: 'width', valueType: 'integer', required: true,
      },
    },
    outputBindings: { video: { marker: 'APP_OUTPUT_VIDEO' } },
    values: { prompt: 'A lantern moves in the rain.', width: 608 },
  };
}

test('workflow loader accepts bounded UTF-8 API JSON and rejects ambiguous input', () => {
  const source = Buffer.from(JSON.stringify(workflowFixture()));
  const loaded = loadComfyWorkflowJson(source);
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(loaded.byteLength, source.length);
  assert.equal(Object.isFrozen(loaded.workflow), true);
  assert.equal(Object.isFrozen(loaded.workflow['10'].inputs), true);
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]);
  assert.equal(loadComfyWorkflowJson(withBom).byteLength, withBom.length);

  assert.throws(
    () => loadComfyWorkflowJson(Buffer.from('{"1":{},"\\u0031":{}}')),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.throws(
    () => loadComfyWorkflowJson(Buffer.from([0xc3, 0x28])),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.throws(
    () => loadComfyWorkflowJson(Buffer.from('{"1":{"class_type":"X","inputs":{"text":"\\ud800"}}}')),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.throws(
    () => loadComfyWorkflowJson(Buffer.from('{"1":{"class_type":"X","inputs":{"text":"\\udc00"}}}')),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.throws(
    () => loadComfyWorkflowJson(Buffer.from('{"\\ud800":{}}')),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.equal(
    loadComfyWorkflowJson(Buffer.from(
      '{"1":{"class_type":"X","inputs":{"text":"\\ud83d\\ude00"}}}',
    )).workflow['1'].inputs.text,
    '😀',
  );
  const tooDeep = `{"1":{"class_type":"X","inputs":{"x":${'['.repeat(33)}0${']'.repeat(33)}}}}`;
  assert.throws(
    () => loadComfyWorkflowJson(Buffer.from(tooDeep)),
    (error) => error.code === 'COMFY_WORKFLOW_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => loadComfyWorkflowJson(Buffer.alloc((4 * 1024 * 1024) + 1, 0x20)),
    (error) => error.code === 'COMFY_WORKFLOW_LIMIT_EXCEEDED',
  );

  let byteReads = 0;
  const proxiedBytes = new Proxy(Buffer.from('{}'), {
    get(target, property, receiver) {
      byteReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => loadComfyWorkflowJson(proxiedBytes),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.equal(byteReads, 0);
});

test('converter normalizes API nodes and indexes unique explicit title markers', () => {
  const converted = convertComfyApiWorkflow(workflowFixture());
  assert.equal(converted.markers.APP_GENERATION_INPUTS, '10');
  assert.equal(converted.markers.APP_OUTPUT_VIDEO, '20');
  assert.equal(Object.isFrozen(converted.graph), true);
  assert.equal(Object.isFrozen(converted.markers), true);

  assert.throws(
    () => convertComfyApiWorkflow({ nodes: [], links: [] }),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  const duplicate = workflowFixture();
  duplicate['30'] = {
    class_type: 'OtherPromptNode',
    inputs: { text: '' },
    _meta: { title: 'APP_GENERATION_INPUTS' },
  };
  assert.throws(
    () => convertComfyApiWorkflow(duplicate),
    (error) => error.code === 'COMFY_WORKFLOW_MARKER_INVALID',
  );
  const malformed = workflowFixture();
  malformed['10']._meta.title = 'APP_bad marker';
  assert.throws(
    () => convertComfyApiWorkflow(malformed),
    (error) => error.code === 'COMFY_WORKFLOW_MARKER_INVALID',
  );
  const danglingLink = workflowFixture();
  danglingLink['20'].inputs.video = ['999', 0];
  assert.throws(
    () => convertComfyApiWorkflow(danglingLink),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  for (const malformedLink of [
    ['999', '0'],
    ['999', -1],
    ['999', 0, 'extra'],
    ['01', 0],
    [999, 0],
  ]) {
    const malformedLinkWorkflow = workflowFixture();
    malformedLinkWorkflow['20'].inputs.video = malformedLink;
    assert.throws(
      () => convertComfyApiWorkflow(malformedLinkWorkflow),
      (error) => error.code === 'COMFY_WORKFLOW_INVALID',
    );
  }
});

test('compiler injects only explicit marker and inputName bindings', () => {
  const source = workflowFixture();
  const compiled = compileComfyWorkflow(compilerInput(source));
  assert.equal(compiled.prompt['10'].inputs.text, 'A lantern moves in the rain.');
  assert.equal(compiled.prompt['10'].inputs.width, 608);
  assert.equal(compiled.prompt['10'].inputs.height, 64);
  assert.equal(compiled.prompt['20'].inputs.filename_prefix, 'jobs/default');
  assert.deepEqual({ ...compiled.outputNodeIds }, { video: '20' });
  assert.equal(source['10'].inputs.text, 'old prompt');
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.prompt['10'].inputs), true);

  const forgedMarkers = compilerInput();
  forgedMarkers.convertedWorkflow = {
    ...forgedMarkers.convertedWorkflow,
    markers: {
      APP_GENERATION_INPUTS: '20',
      APP_OUTPUT_VIDEO: '10',
    },
  };
  const revalidated = compileComfyWorkflow(forgedMarkers);
  assert.equal(revalidated.prompt['10'].inputs.text, 'A lantern moves in the rain.');
  assert.equal(revalidated.outputNodeIds.video, '20');
});

test('compiler fails closed for missing, duplicate, unknown, or wrong-type bindings', () => {
  const missingMarker = compilerInput();
  missingMarker.inputBindings.prompt.marker = 'APP_MISSING';
  assert.throws(
    () => compileComfyWorkflow(missingMarker),
    (error) => error.code === 'COMFY_WORKFLOW_BINDING_INVALID',
  );

  const missingInput = compilerInput();
  missingInput.inputBindings.prompt.inputName = 'unknown_input';
  assert.throws(
    () => compileComfyWorkflow(missingInput),
    (error) => error.code === 'COMFY_WORKFLOW_BINDING_INVALID',
  );

  const duplicateTarget = compilerInput();
  duplicateTarget.inputBindings.alias = {
    marker: 'APP_GENERATION_INPUTS', inputName: 'text', valueType: 'string', required: false,
  };
  assert.throws(
    () => compileComfyWorkflow(duplicateTarget),
    (error) => error.code === 'COMFY_WORKFLOW_BINDING_INVALID',
  );

  const wrongType = compilerInput();
  wrongType.values.width = 608.5;
  assert.throws(
    () => compileComfyWorkflow(wrongType),
    (error) => error.code === 'COMFY_WORKFLOW_INPUT_INVALID',
  );

  const unknownValue = compilerInput();
  unknownValue.values.unbound = 'value';
  assert.throws(
    () => compileComfyWorkflow(unknownValue),
    (error) => error.code === 'COMFY_WORKFLOW_INPUT_INVALID',
  );
});

test('workflow public boundaries reject proxies and accessors without executing them', () => {
  let proxyReads = 0;
  const proxy = new Proxy(workflowFixture(), {
    ownKeys(target) {
      proxyReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () => convertComfyApiWorkflow(proxy),
    (error) => error.code === 'COMFY_WORKFLOW_INVALID',
  );
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const hostile = compilerInput();
  Object.defineProperty(hostile.values, 'prompt', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'hostile';
    },
  });
  assert.throws(
    () => compileComfyWorkflow(hostile),
    (error) => error.code === 'COMFY_WORKFLOW_INPUT_INVALID',
  );
  assert.equal(getterReads, 0);

  const trusted = createComfyWorkflowError('COMFY_WORKFLOW_INVALID');
  assert.equal(isComfyWorkflowError(trusted), true);
  assert.equal(Object.isFrozen(trusted), true);
  const forged = Object.create(ComfyWorkflowError.prototype);
  forged.code = 'COMFY_WORKFLOW_INVALID';
  assert.equal(isComfyWorkflowError(forged), false);

  let errorProxyReads = 0;
  const errorProxy = new Proxy({}, {
    getPrototypeOf() {
      errorProxyReads += 1;
      throw new Error('synthetic workflow error marker');
    },
  });
  assert.equal(isComfyWorkflowError(errorProxy), false);
  assert.equal(errorProxyReads, 0);
});
