import { WorkflowRegistryError } from './errors';

export const WORKFLOW_REGISTRY_SCHEMA_VERSION = '4.0' as const;
export const WORKFLOW_REGISTRY_VERSION = '4.0.0' as const;

const VALUE_TYPE_IDS = [
  'SourceDocument',
  'SourceSelection',
  'StoryFacts',
  'EpisodeBeats',
  'StructuredScript',
  'Character',
  'ReferenceImage',
  'CharacterIdentityVersion',
  'CharacterReferencePack',
  'SceneVersion',
  'PropVersion',
  'AssetRefs',
  'Shot',
  'PromptProfile',
  'PromptSemantic',
  'ImageAsset',
  'WorkflowManifest',
  'VideoAsset',
  'Dialogue',
  'VoiceProfile',
  'AudioAsset',
  'SubtitleTrack',
  'MusicAsset',
  'FinalVideoAsset',
] as const;

const NODE_TYPE_IDS = [
  'source.selection',
  'story.facts',
  'episode.adaptation',
  'script.structured',
  'asset.character',
  'asset.character_candidates',
  'asset.character_pack',
  'asset.scene',
  'asset.prop',
  'shot.plan',
  'shot.image',
  'shot.video',
  'audio.tts',
  'subtitle.align',
  'bgm.track',
  'export.final',
] as const;

export type WorkflowValueType = typeof VALUE_TYPE_IDS[number];
export type WorkflowNodeType = typeof NODE_TYPE_IDS[number];
export type WorkflowPortCardinality = 'one' | 'many';
export type WorkflowPortDirection = 'input' | 'output';

export interface WorkflowPortDefinition {
  readonly id: string;
  readonly valueType: WorkflowValueType;
  readonly cardinality: WorkflowPortCardinality;
  readonly required: boolean;
}

export interface WorkflowNodeTypeDefinition {
  readonly type: WorkflowNodeType;
  readonly title: string;
  readonly inputs: readonly WorkflowPortDefinition[];
  readonly outputs: readonly WorkflowPortDefinition[];
}

export interface WorkflowRegistry {
  readonly schemaVersion: typeof WORKFLOW_REGISTRY_SCHEMA_VERSION;
  readonly registryVersion: typeof WORKFLOW_REGISTRY_VERSION;
  readonly valueTypes: readonly WorkflowValueType[];
  readonly nodes: readonly WorkflowNodeTypeDefinition[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function port(
  id: string,
  valueType: WorkflowValueType,
  cardinality: WorkflowPortCardinality = 'one',
  required = true,
): WorkflowPortDefinition {
  return { id, valueType, cardinality, required };
}

function node(
  type: WorkflowNodeType,
  title: string,
  inputs: WorkflowPortDefinition[],
  outputs: WorkflowPortDefinition[],
): WorkflowNodeTypeDefinition {
  return { type, title, inputs, outputs };
}

const NODE_DEFINITIONS: WorkflowNodeTypeDefinition[] = [
  node('source.selection', '原文选区', [port('document', 'SourceDocument')], [port('selection', 'SourceSelection')]),
  node('story.facts', '故事事实', [port('selection', 'SourceSelection')], [port('facts', 'StoryFacts')]),
  node('episode.adaptation', '单集改编', [port('facts', 'StoryFacts')], [port('beats', 'EpisodeBeats')]),
  node('script.structured', '结构化剧本', [port('beats', 'EpisodeBeats')], [port('script', 'StructuredScript')]),
  node('asset.character', '角色资产', [port('facts', 'StoryFacts')], [port('characters', 'Character', 'many')]),
  node('asset.character_candidates', '角色候选图', [port('character', 'Character')], [port('references', 'ReferenceImage', 'many')]),
  node('asset.character_pack', '角色参考包', [port('identity', 'CharacterIdentityVersion')], [port('pack', 'CharacterReferencePack')]),
  node('asset.scene', '场景资产', [port('facts', 'StoryFacts')], [port('scenes', 'SceneVersion', 'many')]),
  node('asset.prop', '道具资产', [port('facts', 'StoryFacts')], [port('props', 'PropVersion', 'many')]),
  node('shot.plan', '分镜规划', [port('script', 'StructuredScript'), port('assets', 'AssetRefs')], [port('shots', 'Shot', 'many')]),
  node('shot.image', '镜头图像', [port('shot', 'Shot'), port('assets', 'AssetRefs'), port('profile', 'PromptProfile')], [port('image', 'ImageAsset')]),
  node('shot.video', '镜头视频', [port('shot', 'Shot'), port('image', 'ImageAsset', 'one', false), port('assets', 'AssetRefs'), port('workflow', 'WorkflowManifest')], [port('video', 'VideoAsset')]),
  node('audio.tts', '对白配音', [port('dialogues', 'Dialogue', 'many'), port('voice', 'VoiceProfile')], [port('audio', 'AudioAsset', 'many')]),
  node('subtitle.align', '字幕对齐', [port('dialogues', 'Dialogue', 'many'), port('audio', 'AudioAsset', 'many')], [port('subtitle', 'SubtitleTrack')]),
  node('bgm.track', '背景音乐', [port('beats', 'EpisodeBeats')], [port('music', 'MusicAsset')]),
  node('export.final', '成片导出', [port('videos', 'VideoAsset', 'many'), port('audio', 'AudioAsset', 'many', false), port('subtitle', 'SubtitleTrack', 'one', false), port('music', 'MusicAsset', 'one', false)], [port('final', 'FinalVideoAsset')]),
];

function assertUniqueIdentifiers(definitions: readonly WorkflowNodeTypeDefinition[]): void {
  const nodeTypes = new Set<string>();
  const knownValueTypes = new Set<string>(VALUE_TYPE_IDS);
  for (const definition of definitions) {
    if (nodeTypes.has(definition.type)) throw new TypeError('Workflow registry contains a duplicate node type');
    nodeTypes.add(definition.type);
    for (const ports of [definition.inputs, definition.outputs]) {
      const portIds = new Set<string>();
      for (const definitionPort of ports) {
        if (portIds.has(definitionPort.id)) throw new TypeError('Workflow registry contains a duplicate port');
        if (!knownValueTypes.has(definitionPort.valueType)) throw new TypeError('Workflow registry contains an unknown value type');
        portIds.add(definitionPort.id);
      }
    }
  }
  if (nodeTypes.size !== NODE_TYPE_IDS.length) throw new TypeError('Workflow registry node type set is incomplete');
}

assertUniqueIdentifiers(NODE_DEFINITIONS);

const REGISTRY = deepFreeze<WorkflowRegistry>({
  schemaVersion: WORKFLOW_REGISTRY_SCHEMA_VERSION,
  registryVersion: WORKFLOW_REGISTRY_VERSION,
  valueTypes: [...VALUE_TYPE_IDS],
  nodes: NODE_DEFINITIONS,
});

const NODE_BY_TYPE = new Map<WorkflowNodeType, WorkflowNodeTypeDefinition>(
  REGISTRY.nodes.map((definition) => [definition.type, definition]),
);

export function getWorkflowRegistry(): WorkflowRegistry {
  return REGISTRY;
}

export function listNodeTypes(): readonly WorkflowNodeType[] {
  return deepFreeze([...NODE_TYPE_IDS]);
}

export function getNodeTypeDefinition(nodeType: string): WorkflowNodeTypeDefinition {
  const definition = NODE_BY_TYPE.get(nodeType as WorkflowNodeType);
  if (!definition) throw new WorkflowRegistryError('WORKFLOW_NODE_TYPE_UNKNOWN');
  return definition;
}

export function getPortDefinition(
  nodeType: string,
  direction: WorkflowPortDirection,
  portId: string,
): WorkflowPortDefinition {
  const definition = getNodeTypeDefinition(nodeType);
  if (direction !== 'input' && direction !== 'output') {
    throw new WorkflowRegistryError('WORKFLOW_PORT_DIRECTION_INVALID');
  }
  const ports = direction === 'input' ? definition.inputs : definition.outputs;
  const definitionPort = ports.find((candidate) => candidate.id === portId);
  if (!definitionPort) throw new WorkflowRegistryError('WORKFLOW_PORT_UNKNOWN');
  return definitionPort;
}
