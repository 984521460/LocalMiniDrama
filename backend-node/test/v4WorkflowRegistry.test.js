const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const workflowEngineRoot = path.join(__dirname, '..', '..', 'packages', 'workflow-engine');
const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'v4', 'workflow-registry.schema.json');

const EXPECTED_PORTS = Object.freeze({
  'source.selection': {
    inputs: [['document', 'SourceDocument', 'one', true]],
    outputs: [['selection', 'SourceSelection', 'one', true]],
  },
  'story.facts': {
    inputs: [['selection', 'SourceSelection', 'one', true]],
    outputs: [['facts', 'StoryFacts', 'one', true]],
  },
  'episode.adaptation': {
    inputs: [['facts', 'StoryFacts', 'one', true]],
    outputs: [['beats', 'EpisodeBeats', 'one', true]],
  },
  'script.structured': {
    inputs: [['beats', 'EpisodeBeats', 'one', true]],
    outputs: [['script', 'StructuredScript', 'one', true]],
  },
  'asset.character': {
    inputs: [['facts', 'StoryFacts', 'one', true]],
    outputs: [['characters', 'Character', 'many', true]],
  },
  'asset.character_candidates': {
    inputs: [['character', 'Character', 'one', true]],
    outputs: [['references', 'ReferenceImage', 'many', true]],
  },
  'asset.character_pack': {
    inputs: [['identity', 'CharacterIdentityVersion', 'one', true]],
    outputs: [['pack', 'CharacterReferencePack', 'one', true]],
  },
  'asset.scene': {
    inputs: [['facts', 'StoryFacts', 'one', true]],
    outputs: [['scenes', 'SceneVersion', 'many', true]],
  },
  'asset.prop': {
    inputs: [['facts', 'StoryFacts', 'one', true]],
    outputs: [['props', 'PropVersion', 'many', true]],
  },
  'shot.plan': {
    inputs: [['script', 'StructuredScript', 'one', true], ['assets', 'AssetRefs', 'one', true]],
    outputs: [['shots', 'Shot', 'many', true]],
  },
  'shot.image': {
    inputs: [['shot', 'Shot', 'one', true], ['assets', 'AssetRefs', 'one', true], ['profile', 'PromptProfile', 'one', true]],
    outputs: [['image', 'ImageAsset', 'one', true]],
  },
  'shot.video': {
    inputs: [['shot', 'Shot', 'one', true], ['image', 'ImageAsset', 'one', false], ['assets', 'AssetRefs', 'one', true], ['workflow', 'WorkflowManifest', 'one', true]],
    outputs: [['video', 'VideoAsset', 'one', true]],
  },
  'audio.tts': {
    inputs: [['dialogues', 'Dialogue', 'many', true], ['voice', 'VoiceProfile', 'one', true]],
    outputs: [['audio', 'AudioAsset', 'many', true]],
  },
  'subtitle.align': {
    inputs: [['dialogues', 'Dialogue', 'many', true], ['audio', 'AudioAsset', 'many', true]],
    outputs: [['subtitle', 'SubtitleTrack', 'one', true]],
  },
  'bgm.track': {
    inputs: [['beats', 'EpisodeBeats', 'one', true]],
    outputs: [['music', 'MusicAsset', 'one', true]],
  },
  'export.final': {
    inputs: [['videos', 'VideoAsset', 'many', true], ['audio', 'AudioAsset', 'many', true], ['subtitle', 'SubtitleTrack', 'one', false], ['music', 'MusicAsset', 'one', false]],
    outputs: [['final', 'FinalVideoAsset', 'one', true]],
  },
});

function portTuples(ports) {
  return ports.map((port) => [port.id, port.valueType, port.cardinality, port.required]);
}

test('publishes the exact versioned Phase 4 node and port registry', () => {
  const { getWorkflowRegistry } = require(workflowEngineRoot);
  const registry = getWorkflowRegistry();

  assert.equal(registry.schemaVersion, '4.0');
  assert.equal(registry.registryVersion, '4.0.0');
  assert.deepEqual(registry.nodes.map((node) => node.type), Object.keys(EXPECTED_PORTS));
  assert.equal(new Set(registry.valueTypes).size, registry.valueTypes.length);
  assert.ok(registry.valueTypes.includes('PromptSemantic'));

  for (const node of registry.nodes) {
    assert.deepEqual(portTuples(node.inputs), EXPECTED_PORTS[node.type].inputs);
    assert.deepEqual(portTuples(node.outputs), EXPECTED_PORTS[node.type].outputs);
  }
});

test('returns immutable registry snapshots and stable lookup failures', () => {
  const {
    WorkflowRegistryError,
    getNodeTypeDefinition,
    getPortDefinition,
    getWorkflowRegistry,
    listNodeTypes,
  } = require(workflowEngineRoot);

  const registry = getWorkflowRegistry();
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.nodes));
  assert.ok(Object.isFrozen(registry.nodes[0]));
  assert.ok(Object.isFrozen(registry.nodes[0].inputs));
  assert.ok(Object.isFrozen(registry.nodes[0].inputs[0]));
  assert.deepEqual(listNodeTypes(), Object.keys(EXPECTED_PORTS));
  assert.equal(getNodeTypeDefinition('story.facts').type, 'story.facts');
  assert.equal(getPortDefinition('story.facts', 'input', 'selection').valueType, 'SourceSelection');

  for (const callback of [
    () => getNodeTypeDefinition('unknown.node'),
    () => getPortDefinition('story.facts', 'sideways', 'selection'),
    () => getPortDefinition('story.facts', 'input', 'missing'),
  ]) {
    assert.throws(callback, (error) => {
      assert.ok(error instanceof WorkflowRegistryError);
      assert.match(error.code, /^WORKFLOW_(NODE_TYPE|PORT|PORT_DIRECTION)_/);
      assert.doesNotMatch(JSON.stringify(error), /unknown\.node|sideways|missing/);
      return true;
    });
  }
});

test('keeps the registry aligned with the strict public v4 JSON Schema', () => {
  const { getWorkflowRegistry } = require(workflowEngineRoot);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const registry = getWorkflowRegistry();

  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
  const malformed = JSON.parse(JSON.stringify(registry));
  malformed.nodes[0].inputs[0].cardinality = 'unbounded';
  assert.equal(validate(malformed), false);
  assert.ok(validate.errors.some((error) => error.instancePath.endsWith('/cardinality')));

  const extended = JSON.parse(JSON.stringify(registry));
  extended.nodes[0].unexpected = true;
  assert.equal(validate(extended), false);
});

test('exposes only canonical node and port identifiers', () => {
  const { getWorkflowRegistry } = require(workflowEngineRoot);
  const registry = getWorkflowRegistry();
  for (const node of registry.nodes) {
    assert.match(node.type, /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/);
    for (const port of [...node.inputs, ...node.outputs]) {
      assert.match(port.id, /^[a-z][a-zA-Z0-9]*$/);
      assert.match(port.valueType, /^[A-Z][A-Za-z0-9]*$/);
    }
  }
});
