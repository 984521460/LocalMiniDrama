const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const Ajv = require('ajv/dist/2020');

const {
  NarrativeTaskError,
  createEpisodeAdaptationTask,
  createNovelExtractionTask,
  createPromptSemanticTask,
  createScriptFormattingTask,
  createShotPlanningTask,
} = require('../src/narrative/tasks');
const episodeAdaptationSchema = require('../../schemas/v3/episode-adaptation.schema.json');
const novelExtractionSchema = require('../../schemas/v3/novel-extraction.schema.json');
const promptSemanticSchema = require('../../schemas/v3/prompt-semantic.schema.json');
const scriptFormattingSchema = require('../../schemas/v3/script-formatting.schema.json');
const shotPlanningSchema = require('../../schemas/v3/shot-planning.schema.json');

const IDS = Object.freeze({
  document: '10000000-0000-4000-8000-000000000001',
  selection: '10000000-0000-4000-8000-000000000002',
  blockA: '10000000-0000-4000-8000-000000000003',
  blockB: '10000000-0000-4000-8000-000000000004',
});

const TEXT_A = '赵云在雨夜进入客栈。';
const TEXT_B = '掌柜说道：“楼上有人。”';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256Canonical(value) {
  return sha256(canonicalJson(value));
}

function codePointLength(value) {
  return Array.from(value).length;
}

function createSource(overrides = {}) {
  const blocks = [
    {
      uid: IDS.blockA,
      documentUid: IDS.document,
      ordinal: 0,
      text: TEXT_A,
      textSha256: sha256(TEXT_A),
    },
    {
      uid: IDS.blockB,
      documentUid: IDS.document,
      ordinal: 1,
      text: TEXT_B,
      textSha256: sha256(TEXT_B),
    },
  ];
  const selection = {
    uid: IDS.selection,
    documentUid: IDS.document,
    startBlockUid: IDS.blockA,
    endBlockUid: IDS.blockB,
    startOffset: 0,
    endOffset: codePointLength(TEXT_B),
    selectedTextSha256: sha256(TEXT_A + TEXT_B),
  };
  return {
    documentUid: IDS.document,
    blocks,
    selection,
    ...overrides,
  };
}

function evidence(blockUid, text, quote) {
  const startOffset = Array.from(text).indexOf(Array.from(quote)[0]);
  assert.notEqual(startOffset, -1);
  return {
    blockUid,
    startOffset,
    endOffset: startOffset + codePointLength(quote),
    quote,
  };
}

function createValidOutput() {
  return {
    schemaVersion: 'novel-extraction.v1',
    characters: [
      {
        factId: 'character-zhao-yun',
        name: '赵云',
        description: '雨夜进入客栈的人',
        evidence: [evidence(IDS.blockA, TEXT_A, '赵云')],
      },
      {
        factId: 'character-innkeeper',
        name: '掌柜',
        description: '告知楼上有人的掌柜',
        evidence: [evidence(IDS.blockB, TEXT_B, '掌柜')],
      },
    ],
    scenes: [
      {
        factId: 'scene-inn',
        location: '客栈',
        time: '雨夜',
        description: '雨夜的客栈',
        evidence: [evidence(IDS.blockA, TEXT_A, '雨夜')],
      },
    ],
    props: [],
    relationships: [],
    events: [
      {
        factId: 'event-enter-inn',
        summary: '赵云在雨夜进入客栈',
        characterFactIds: ['character-zhao-yun'],
        sceneFactId: 'scene-inn',
        propFactIds: [],
        evidence: [evidence(IDS.blockA, TEXT_A, '赵云在雨夜进入客栈')],
      },
    ],
    dialogue: [
      {
        factId: 'dialogue-upstairs',
        speakerCharacterFactId: 'character-innkeeper',
        content: '楼上有人。',
        evidence: [evidence(IDS.blockB, TEXT_B, '楼上有人。')],
      },
    ],
  };
}

function createCompletion(overrides = {}) {
  return {
    source: createSource(),
    promptVersion: 'novel-extraction.prompt.v1',
    model: { provider: 'fixture', name: 'fixture-model' },
    parameters: { temperature: 0, responseFormat: 'json' },
    rawResponseRef: 'response:v1:10000000-0000-4000-8000-000000000005',
    rawResponse: JSON.stringify(createValidOutput()),
    ...overrides,
  };
}

function createValidAdaptationOutput() {
  return {
    schemaVersion: 'episode-adaptation.v1',
    durationSummary: {
      targetSeconds: 60,
      toleranceSeconds: 5,
      totalSeconds: 60,
    },
    beats: [
      {
        beatId: 'beat-rainy-arrival',
        kind: 'hook',
        summary: '赵云冒雨进入客栈。',
        classification: 'fact',
        inferenceRationale: null,
        estimatedDurationSeconds: 8,
        factRefs: ['event-enter-inn'],
        adaptationDecisionRefs: [],
      },
      {
        beatId: 'beat-tense-inn',
        kind: 'setup',
        summary: '雨夜客栈显得格外紧张。',
        classification: 'inference',
        inferenceRationale: '由雨夜与陌生客栈环境推断紧张气氛。',
        estimatedDurationSeconds: 12,
        factRefs: ['scene-inn'],
        adaptationDecisionRefs: [],
      },
      {
        beatId: 'beat-upstairs-warning',
        kind: 'escalation',
        summary: '掌柜的警告引出楼上追兵。',
        classification: 'adaptation',
        inferenceRationale: null,
        estimatedDurationSeconds: 15,
        factRefs: ['dialogue-upstairs'],
        adaptationDecisionRefs: ['decision-add-pursuer'],
      },
      {
        beatId: 'beat-stair-confrontation',
        kind: 'climax',
        summary: '赵云冲上楼与追兵正面对峙。',
        classification: 'adaptation',
        inferenceRationale: null,
        estimatedDurationSeconds: 15,
        factRefs: ['character-zhao-yun'],
        adaptationDecisionRefs: ['decision-add-pursuer'],
      },
      {
        beatId: 'beat-hidden-identity',
        kind: 'cliffhanger',
        summary: '追兵说出赵云不该知道的秘密。',
        classification: 'adaptation',
        inferenceRationale: null,
        estimatedDurationSeconds: 10,
        factRefs: ['character-zhao-yun'],
        adaptationDecisionRefs: ['decision-add-pursuer'],
      },
    ],
    adaptationDecisions: [
      {
        decisionId: 'decision-add-pursuer',
        classification: 'adaptation',
        category: 'invented-event',
        summary: '新增楼上追兵与对峙。',
        rationale: '把原文警告转成一分钟单集的升级、高潮和悬念。',
        factRefs: ['character-zhao-yun', 'dialogue-upstairs'],
      },
    ],
  };
}

function createAdaptationCompletion(overrides = {}) {
  const approvedExtraction = createValidOutput();
  return {
    approvedExtraction,
    approval: {
      status: 'approved',
      resultHash: sha256Canonical(approvedExtraction),
      reviewRef: 'review:v1:10000000-0000-4000-8000-000000000006',
    },
    durationBudget: { targetSeconds: 60, toleranceSeconds: 5 },
    style: { genre: '武侠', tone: '紧张', audience: '全年龄' },
    promptVersion: 'episode-adaptation.prompt.v1',
    model: { provider: 'fixture', name: 'fixture-model' },
    parameters: { temperature: 0.2, responseFormat: 'json' },
    rawResponseRef: 'response:v1:10000000-0000-4000-8000-000000000007',
    rawResponse: JSON.stringify(createValidAdaptationOutput()),
    ...overrides,
  };
}

function createValidScriptOutput() {
  return {
    schemaVersion: 'script-formatting.v1',
    durationSummary: { totalSeconds: 60 },
    scenes: [
      {
        sceneId: 'script-scene-inn-floor',
        ordinal: 1,
        heading: { interiorExterior: 'INT', location: '客栈', time: '雨夜' },
        purpose: '建立雨夜客栈与楼上威胁。',
        sceneFactRef: 'scene-inn',
        characterFactRefs: ['character-zhao-yun', 'character-innkeeper'],
        propFactRefs: [],
        beatRefs: ['beat-rainy-arrival', 'beat-tense-inn', 'beat-upstairs-warning'],
        adaptationDecisionRefs: ['decision-add-pursuer'],
        estimatedDurationSeconds: 35,
        entries: [
          {
            entryId: 'entry-arrival-action',
            type: 'action',
            text: '赵云推门进入雨夜中的客栈。',
            characterFactRefs: ['character-zhao-yun'],
            propFactRefs: [],
            beatRefs: ['beat-rainy-arrival', 'beat-tense-inn'],
            adaptationDecisionRefs: [],
            durationSeconds: 13,
          },
          {
            entryId: 'entry-upstairs-dialogue',
            type: 'dialogue',
            speakerCharacterFactId: 'character-innkeeper',
            dialogueFactRef: 'dialogue-upstairs',
            text: '楼上有人。',
            emotion: '警惕',
            speechRateWordsPerMinute: 120,
            narrativePurpose: 'escalation',
            beatRefs: ['beat-upstairs-warning'],
            adaptationDecisionRefs: [],
            durationSeconds: 7,
          },
          {
            entryId: 'entry-upstairs-reveal',
            type: 'action',
            text: '楼板传来追兵逼近的脚步声。',
            characterFactRefs: [],
            propFactRefs: [],
            beatRefs: ['beat-upstairs-warning'],
            adaptationDecisionRefs: ['decision-add-pursuer'],
            durationSeconds: 15,
          },
        ],
      },
      {
        sceneId: 'script-scene-inn-upstairs',
        ordinal: 2,
        heading: { interiorExterior: 'INT', location: '客栈', time: '雨夜' },
        purpose: '完成对峙并留下身份悬念。',
        sceneFactRef: 'scene-inn',
        characterFactRefs: ['character-zhao-yun'],
        propFactRefs: [],
        beatRefs: ['beat-stair-confrontation', 'beat-hidden-identity'],
        adaptationDecisionRefs: ['decision-add-pursuer'],
        estimatedDurationSeconds: 25,
        entries: [
          {
            entryId: 'entry-stair-action',
            type: 'action',
            text: '赵云冲上楼，与追兵隔着长廊对峙。',
            characterFactRefs: ['character-zhao-yun'],
            propFactRefs: [],
            beatRefs: ['beat-stair-confrontation'],
            adaptationDecisionRefs: ['decision-add-pursuer'],
            durationSeconds: 15,
          },
          {
            entryId: 'entry-secret-dialogue',
            type: 'dialogue',
            speakerCharacterFactId: null,
            dialogueFactRef: null,
            text: '你终于来了。',
            emotion: '冷峻',
            speechRateWordsPerMinute: 100,
            narrativePurpose: 'cliffhanger',
            beatRefs: ['beat-hidden-identity'],
            adaptationDecisionRefs: ['decision-add-pursuer'],
            durationSeconds: 10,
          },
        ],
      },
    ],
  };
}

function createFactOnlyOpeningScript(interiorExterior) {
  const output = createValidScriptOutput();
  const opening = output.scenes[0];
  const confrontation = output.scenes[1];
  const movedEntries = opening.entries.slice(1);
  opening.heading.interiorExterior = interiorExterior;
  opening.beatRefs = ['beat-rainy-arrival', 'beat-tense-inn'];
  opening.adaptationDecisionRefs = [];
  opening.estimatedDurationSeconds = 13;
  opening.entries = [opening.entries[0]];

  confrontation.characterFactRefs.push('character-innkeeper');
  confrontation.beatRefs = [
    'beat-upstairs-warning',
    'beat-stair-confrontation',
    'beat-hidden-identity',
  ];
  confrontation.estimatedDurationSeconds = 47;
  confrontation.entries = [...movedEntries, ...confrontation.entries];
  return output;
}

function createScriptCompletion(overrides = {}) {
  const adaptationInput = createAdaptationCompletion();
  const adaptationResult = createEpisodeAdaptationTask().complete(adaptationInput);
  return {
    approvedExtraction: adaptationInput.approvedExtraction,
    extractionApproval: adaptationInput.approval,
    adaptationResult,
    adaptationApproval: {
      status: 'approved',
      resultHash: sha256Canonical(adaptationResult.output),
      reviewRef: 'review:v1:10000000-0000-4000-8000-000000000008',
    },
    promptVersion: 'script-formatting.prompt.v1',
    model: { provider: 'fixture', name: 'fixture-model' },
    parameters: { temperature: 0, responseFormat: 'json' },
    rawResponseRef: 'response:v1:10000000-0000-4000-8000-000000000009',
    rawResponse: JSON.stringify(createValidScriptOutput()),
    ...overrides,
  };
}

function createAssetVersions() {
  return [
    {
      assetVersionRef: 'asset-version:v1:20000000-0000-4000-8000-000000000001',
      assetType: 'scene',
      bindingRef: 'script-scene-inn-floor',
    },
    {
      assetVersionRef: 'asset-version:v1:20000000-0000-4000-8000-000000000002',
      assetType: 'scene',
      bindingRef: 'script-scene-inn-upstairs',
    },
    {
      assetVersionRef: 'asset-version:v1:20000000-0000-4000-8000-000000000003',
      assetType: 'character',
      bindingRef: 'character-zhao-yun',
    },
    {
      assetVersionRef: 'asset-version:v1:20000000-0000-4000-8000-000000000004',
      assetType: 'character',
      bindingRef: 'character-innkeeper',
    },
  ];
}

function shot({
  shotId,
  ordinal,
  sceneId,
  entryRef,
  durationSeconds,
  shotSize,
  cameraAngle,
  cameraMovement,
  action,
  characterFactRefs = [],
  propFactRefs = [],
  dialogueEntryRefs = [],
  assetVersionRefs = [],
  transitionFromPrevious,
  screenDirection,
  axisStrategy,
}) {
  return {
    shotId,
    ordinal,
    sceneId,
    entryRefs: [entryRef],
    durationSeconds,
    shotSize,
    cameraAngle,
    cameraMovement,
    composition: '16:9 真人影视写实构图。',
    action,
    characterFactRefs,
    propFactRefs,
    dialogueEntryRefs,
    assetVersionRefs,
    continuity: {
      transitionFromPrevious,
      screenDirection,
      axisStrategy,
      notes: '保持人物朝向、视线与场景空间连续。',
    },
  };
}

function createValidShotPlanningOutput() {
  const floorAsset = 'asset-version:v1:20000000-0000-4000-8000-000000000001';
  const upstairsAsset = 'asset-version:v1:20000000-0000-4000-8000-000000000002';
  const zhaoAsset = 'asset-version:v1:20000000-0000-4000-8000-000000000003';
  const innkeeperAsset = 'asset-version:v1:20000000-0000-4000-8000-000000000004';
  return {
    schemaVersion: 'shot-planning.v1',
    aspectRatio: '16:9',
    durationSummary: { totalSeconds: 60 },
    shots: [
      shot({
        shotId: 'shot-rainy-arrival', ordinal: 1,
        sceneId: 'script-scene-inn-floor', entryRef: 'entry-arrival-action',
        durationSeconds: 13, shotSize: 'MS', cameraAngle: 'eye_level',
        cameraMovement: 'dolly', action: '跟随赵云推门进入客栈。',
        characterFactRefs: ['character-zhao-yun'],
        assetVersionRefs: [floorAsset, zhaoAsset],
        transitionFromPrevious: 'start', screenDirection: 'left_to_right',
        axisStrategy: 'establish',
      }),
      shot({
        shotId: 'shot-innkeeper-warning', ordinal: 2,
        sceneId: 'script-scene-inn-floor', entryRef: 'entry-upstairs-dialogue',
        durationSeconds: 7, shotSize: 'CU', cameraAngle: 'eye_level',
        cameraMovement: 'static', action: '切至掌柜警惕地发出警告。',
        characterFactRefs: ['character-innkeeper'],
        dialogueEntryRefs: ['entry-upstairs-dialogue'],
        assetVersionRefs: [floorAsset, innkeeperAsset],
        transitionFromPrevious: 'cut', screenDirection: 'left_to_right',
        axisStrategy: 'maintain',
      }),
      shot({
        shotId: 'shot-footsteps-reveal', ordinal: 3,
        sceneId: 'script-scene-inn-floor', entryRef: 'entry-upstairs-reveal',
        durationSeconds: 15, shotSize: 'LS', cameraAngle: 'low',
        cameraMovement: 'tilt', action: '镜头沿楼梯上仰，脚步声逐渐逼近。',
        assetVersionRefs: [floorAsset],
        transitionFromPrevious: 'cut', screenDirection: 'left_to_right',
        axisStrategy: 'maintain',
      }),
      shot({
        shotId: 'shot-stair-confrontation', ordinal: 4,
        sceneId: 'script-scene-inn-upstairs', entryRef: 'entry-stair-action',
        durationSeconds: 15, shotSize: 'MLS', cameraAngle: 'low',
        cameraMovement: 'handheld', action: '赵云冲上楼，在长廊中停步对峙。',
        characterFactRefs: ['character-zhao-yun'],
        assetVersionRefs: [upstairsAsset, zhaoAsset],
        transitionFromPrevious: 'cut', screenDirection: 'right_to_left',
        axisStrategy: 'establish',
      }),
      shot({
        shotId: 'shot-hidden-identity', ordinal: 5,
        sceneId: 'script-scene-inn-upstairs', entryRef: 'entry-secret-dialogue',
        durationSeconds: 10, shotSize: 'CU', cameraAngle: 'eye_level',
        cameraMovement: 'dolly', action: '缓慢推进赵云的反应，画外音留下悬念。',
        characterFactRefs: ['character-zhao-yun'],
        dialogueEntryRefs: ['entry-secret-dialogue'],
        assetVersionRefs: [upstairsAsset, zhaoAsset],
        transitionFromPrevious: 'cut', screenDirection: 'right_to_left',
        axisStrategy: 'maintain',
      }),
    ],
  };
}

function createShotPlanningCompletion(overrides = {}) {
  const scriptInput = createScriptCompletion();
  const scriptResult = createScriptFormattingTask().complete(scriptInput);
  return {
    approvedExtraction: scriptInput.approvedExtraction,
    extractionApproval: scriptInput.extractionApproval,
    adaptationResult: scriptInput.adaptationResult,
    adaptationApproval: scriptInput.adaptationApproval,
    scriptResult,
    scriptApproval: {
      status: 'approved',
      resultHash: sha256Canonical(scriptResult.output),
      reviewRef: 'review:v1:10000000-0000-4000-8000-000000000010',
    },
    assetVersions: createAssetVersions(),
    promptVersion: 'shot-planning.prompt.v1',
    model: { provider: 'fixture', name: 'fixture-model' },
    parameters: { temperature: 0, responseFormat: 'json' },
    rawResponseRef: 'response:v1:10000000-0000-4000-8000-000000000011',
    rawResponse: JSON.stringify(createValidShotPlanningOutput()),
    ...overrides,
  };
}

function createValidPromptSemanticOutput() {
  const plan = createValidShotPlanningOutput();
  const assets = new Map(createAssetVersions().map(
    (asset) => [asset.assetVersionRef, asset],
  ));
  return {
    schemaVersion: 'prompt-semantic.v1',
    aspectRatio: plan.aspectRatio,
    durationSummary: structuredClone(plan.durationSummary),
    semanticShots: plan.shots.map((plannedShot) => {
      const refsOfType = (assetType) => plannedShot.assetVersionRefs.filter(
        (ref) => assets.get(ref)?.assetType === assetType,
      );
      return {
        shotId: plannedShot.shotId,
        ordinal: plannedShot.ordinal,
        durationSeconds: plannedShot.durationSeconds,
        subjects: {
          characterFactRefs: structuredClone(plannedShot.characterFactRefs),
          characterAssetVersionRefs: refsOfType('character'),
          description: plannedShot.characterFactRefs.length > 0
            ? '人物外观遵循已批准角色资产，姿态服务于当前动作。'
            : '画面以环境和动作线索为主体，不新增人物。',
        },
        environment: {
          sceneId: plannedShot.sceneId,
          sceneAssetVersionRefs: refsOfType('scene'),
          propFactRefs: structuredClone(plannedShot.propFactRefs),
          propAssetVersionRefs: refsOfType('prop'),
          description: '场景空间遵循已批准资产，保持前后镜头方位一致。',
        },
        action: plannedShot.action,
        camera: {
          shotSize: plannedShot.shotSize,
          cameraAngle: plannedShot.cameraAngle,
          cameraMovement: plannedShot.cameraMovement,
          composition: plannedShot.composition,
        },
        lighting: {
          quality: 'soft',
          direction: 'side',
          colorTemperature: 'cool',
          description: '雨夜冷色侧光，人物面部保持可辨识层次。',
        },
        continuity: {
          transitionFromPrevious: plannedShot.continuity.transitionFromPrevious,
          screenDirection: plannedShot.continuity.screenDirection,
          axisStrategy: plannedShot.continuity.axisStrategy,
          notes: plannedShot.continuity.notes,
        },
      };
    }),
  };
}

function createPromptSemanticCompletion(overrides = {}) {
  const shotInput = createShotPlanningCompletion();
  const shotPlanningResult = createShotPlanningTask().complete(shotInput);
  return {
    approvedExtraction: shotInput.approvedExtraction,
    extractionApproval: shotInput.extractionApproval,
    adaptationResult: shotInput.adaptationResult,
    adaptationApproval: shotInput.adaptationApproval,
    scriptResult: shotInput.scriptResult,
    scriptApproval: shotInput.scriptApproval,
    assetVersions: shotInput.assetVersions,
    shotPlanningResult,
    shotPlanningApproval: {
      status: 'approved',
      resultHash: sha256Canonical(shotPlanningResult.output),
      envelopeHash: sha256Canonical(shotPlanningResult),
      reviewRef: 'review:v1:10000000-0000-4000-8000-000000000012',
    },
    promptVersion: 'prompt-semantic.prompt.v1',
    model: { provider: 'fixture', name: 'fixture-model' },
    parameters: { temperature: 0, responseFormat: 'json' },
    rawResponseRef: 'response:v1:10000000-0000-4000-8000-000000000013',
    rawResponse: JSON.stringify(createValidPromptSemanticOutput()),
    ...overrides,
  };
}

function assertTaskError(code) {
  return (error) => error instanceof NarrativeTaskError
    && error.code === code
    && !error.message.includes('赵云')
    && !error.message.includes('fixture-model');
}

test('novel extraction schema is strict, versioned, and requires evidence for every fact', () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(novelExtractionSchema);
  const valid = createValidOutput();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const noEvidence = structuredClone(valid);
  noEvidence.characters[0].evidence = [];
  assert.equal(validate(noEvidence), false);

  const adaptation = structuredClone(valid);
  adaptation.events[0].adaptation = '新增反派';
  assert.equal(validate(adaptation), false);

  const wrongVersion = structuredClone(valid);
  wrongVersion.schemaVersion = 'novel-extraction.v2';
  assert.equal(validate(wrongVersion), false);
});

test('NovelExtractionTask returns deterministic auditable metadata and immutable output', () => {
  const task = createNovelExtractionTask();
  const completion = createCompletion();
  const result = task.complete(completion);

  assert.equal(result.taskType, 'NovelExtractionTask');
  assert.equal(result.schemaVersion, 'novel-extraction.v1');
  assert.equal(result.promptVersion, completion.promptVersion);
  assert.equal(result.model.provider, 'fixture');
  assert.equal(result.model.name, 'fixture-model');
  assert.deepEqual(result.parameters, completion.parameters);
  assert.equal(result.rawResponseRef, completion.rawResponseRef);
  assert.equal(result.rawResponseSha256, sha256(completion.rawResponse));
  assert.match(result.inputHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.output.characters[0].name, '赵云');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output.characters[0].evidence[0]), true);
  assert.equal(JSON.stringify(result).includes(completion.rawResponse), false);

  const reordered = createCompletion({
    source: {
      selection: structuredClone(completion.source.selection),
      blocks: structuredClone(completion.source.blocks),
      documentUid: completion.source.documentUid,
    },
    parameters: { responseFormat: 'json', temperature: 0 },
  });
  assert.equal(task.complete(reordered).inputHash, result.inputHash);

  completion.parameters.temperature = 1;
  const parsed = JSON.parse(completion.rawResponse);
  parsed.characters[0].name = '已篡改';
  completion.rawResponse = JSON.stringify(parsed);
  assert.equal(result.parameters.temperature, 0);
  assert.equal(result.output.characters[0].name, '赵云');
});

test('NovelExtractionTask rejects unknown, mismatched, and out-of-selection evidence', () => {
  const task = createNovelExtractionTask();
  const cases = [];

  const unknownBlock = createValidOutput();
  unknownBlock.characters[0].evidence[0].blockUid = '90000000-0000-4000-8000-000000000001';
  cases.push(createCompletion({ rawResponse: JSON.stringify(unknownBlock) }));

  const wrongQuote = createValidOutput();
  wrongQuote.characters[0].evidence[0].quote = '虚构';
  cases.push(createCompletion({ rawResponse: JSON.stringify(wrongQuote) }));

  const outOfBounds = createValidOutput();
  outOfBounds.characters[0].evidence[0].endOffset = 999;
  cases.push(createCompletion({ rawResponse: JSON.stringify(outOfBounds) }));

  const partialSource = createSource();
  partialSource.selection.startOffset = 2;
  partialSource.selection.selectedTextSha256 = sha256(Array.from(TEXT_A).slice(2).join('') + TEXT_B);
  cases.push(createCompletion({ source: partialSource }));

  for (const input of cases) {
    assert.throws(() => task.complete(input), assertTaskError('NARRATIVE_TASK_EVIDENCE_INVALID'));
  }
});

test('NovelExtractionTask rejects dangling fact references and duplicate fact identities', () => {
  const task = createNovelExtractionTask();
  const dangling = createValidOutput();
  dangling.dialogue[0].speakerCharacterFactId = 'character-missing';
  assert.throws(
    () => task.complete(createCompletion({ rawResponse: JSON.stringify(dangling) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const duplicate = createValidOutput();
  duplicate.events[0].factId = duplicate.characters[0].factId;
  assert.throws(
    () => task.complete(createCompletion({ rawResponse: JSON.stringify(duplicate) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );
});

test('NovelExtractionTask fails closed on malformed inputs, responses, and response limits', () => {
  const task = createNovelExtractionTask();
  assert.throws(
    () => task.complete(createCompletion({ rawResponse: '{"schemaVersion":' })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );
  assert.throws(
    () => task.complete(createCompletion({ promptVersion: '' })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
  assert.throws(
    () => task.complete(createCompletion({ rawResponse: ' '.repeat((4 * 1024 * 1024) + 1) })),
    assertTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED'),
  );

  const oversizedText = '文'.repeat(3001);
  const oversizedSource = createSource({
    blocks: [{
      uid: IDS.blockA,
      documentUid: IDS.document,
      ordinal: 0,
      text: oversizedText,
      textSha256: sha256(oversizedText),
    }],
    selection: {
      uid: IDS.selection,
      documentUid: IDS.document,
      startBlockUid: IDS.blockA,
      endBlockUid: IDS.blockA,
      startOffset: 0,
      endOffset: codePointLength(oversizedText),
      selectedTextSha256: sha256(oversizedText),
    },
  });
  assert.throws(
    () => task.complete(createCompletion({ source: oversizedSource })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('NovelExtractionTask does not invoke accessors or disclose rejected response values', () => {
  const task = createNovelExtractionTask();
  let getterCalls = 0;
  const accessorInput = createCompletion();
  Object.defineProperty(accessorInput, 'rawResponse', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return JSON.stringify(createValidOutput());
    },
  });
  assert.throws(
    () => task.complete(accessorInput),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
  assert.equal(getterCalls, 0);

  const marker = 'synthetic-private-response-marker';
  let captured;
  try {
    task.complete(createCompletion({
      rawResponse: JSON.stringify({
        ...createValidOutput(),
        privateValue: marker,
      }),
    }));
  } catch (error) {
    captured = error;
  }
  assert.ok(captured);
  assert.equal(captured.message.includes(marker), false);
  assert.equal(captured.stack.includes(marker), false);
  assert.equal(JSON.stringify(captured).includes(marker), false);
});

test('NovelExtractionTask fails closed on prototype pollution metadata', () => {
  const task = createNovelExtractionTask();
  const model = { provider: 'fixture', name: 'fixture-model' };
  Object.defineProperty(model, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { inheritedMarker: 'synthetic-hidden-model-state' },
    writable: true,
  });
  assert.throws(
    () => task.complete(createCompletion({ model })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const parameters = { temperature: 0 };
  Object.defineProperty(parameters, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { inheritedMarker: 'synthetic-hidden-parameter-state' },
    writable: true,
  });
  const result = task.complete(createCompletion({ parameters }));
  assert.equal(Object.getPrototypeOf(result.parameters), Object.prototype);
  assert.equal(Object.hasOwn(result.parameters, '__proto__'), true);
  assert.equal(result.parameters.inheritedMarker, undefined);
  assert.equal(Object.isFrozen(result.parameters.__proto__), true);

  const nullPrototypeParameters = Object.create(null);
  nullPrototypeParameters.constructor = 'synthetic-data-constructor';
  nullPrototypeParameters.prototype = { safe: true };
  const nullPrototypeResult = task.complete(createCompletion({
    parameters: nullPrototypeParameters,
  }));
  assert.equal(Object.hasOwn(nullPrototypeResult.parameters, 'constructor'), true);
  assert.equal(Object.hasOwn(nullPrototypeResult.parameters, 'prototype'), true);
  assert.equal(Object.isFrozen(nullPrototypeResult.parameters.prototype), true);

  const source = createSource();
  Object.defineProperty(source, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { inheritedMarker: 'synthetic-hidden-source-state' },
    writable: true,
  });
  assert.throws(
    () => task.complete(createCompletion({ source })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const responseWithPrototypeKey = JSON.stringify({
    ...createValidOutput(),
    ['__proto__']: { inheritedMarker: 'synthetic-hidden-response-state' },
  });
  assert.throws(
    () => task.complete(createCompletion({ rawResponse: responseWithPrototypeKey })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );
});

test('NovelExtractionTask only accepts opaque canonical raw response references', () => {
  const task = createNovelExtractionTask();
  const rejectedRefs = [
    'response:v1:sk-proj-SYNTHETIC_SECRET_123',
    'response:v1:AKIAIOSFODNN7EXAMPLE',
    'response:v1:C:Users:private',
    'response:v1:10000000-0000-4000-8000-00000000000A',
  ];
  for (const rawResponseRef of rejectedRefs) {
    assert.throws(
      () => task.complete(createCompletion({ rawResponseRef })),
      assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
    );
  }
});

test('episode adaptation schema requires five ordered, explicitly classified beats', () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(episodeAdaptationSchema);
  const valid = createValidAdaptationOutput();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const disguisedFact = structuredClone(valid);
  disguisedFact.beats[0].adaptationDecisionRefs = ['decision-add-pursuer'];
  assert.equal(validate(disguisedFact), false);

  const unexplainedInference = structuredClone(valid);
  unexplainedInference.beats[1].inferenceRationale = null;
  assert.equal(validate(unexplainedInference), false);

  const unlabeledAdaptation = structuredClone(valid);
  unlabeledAdaptation.beats[2].adaptationDecisionRefs = [];
  assert.equal(validate(unlabeledAdaptation), false);

  const extraField = structuredClone(valid);
  extraField.beats[0].providerPrompt = 'forbidden';
  assert.equal(validate(extraField), false);
});

test('EpisodeAdaptationTask returns immutable audit metadata bound to approved facts', () => {
  const task = createEpisodeAdaptationTask();
  const completion = createAdaptationCompletion();
  const result = task.complete(completion);

  assert.equal(result.taskType, 'EpisodeAdaptationTask');
  assert.equal(result.schemaVersion, 'episode-adaptation.v1');
  assert.equal(result.promptVersion, completion.promptVersion);
  assert.equal(result.upstreamResultHash, completion.approval.resultHash);
  assert.equal(result.approvalRef, completion.approval.reviewRef);
  assert.deepEqual(result.durationBudget, completion.durationBudget);
  assert.deepEqual(result.style, completion.style);
  assert.equal(result.rawResponseRef, completion.rawResponseRef);
  assert.equal(result.rawResponseSha256, sha256(completion.rawResponse));
  assert.match(result.inputHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.output.durationSummary.totalSeconds, 60);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output.beats[0]), true);
  assert.equal(JSON.stringify(result).includes(completion.rawResponse), false);

  const reordered = createAdaptationCompletion({
    style: { audience: '全年龄', tone: '紧张', genre: '武侠' },
    durationBudget: { toleranceSeconds: 5, targetSeconds: 60 },
  });
  assert.equal(task.complete(reordered).inputHash, result.inputHash);
});

test('EpisodeAdaptationTask requires an approval hash matching the exact extraction', () => {
  const task = createEpisodeAdaptationTask();
  const unapproved = createAdaptationCompletion();
  unapproved.approval.status = 'pending';
  assert.throws(
    () => task.complete(unapproved),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const drifted = createAdaptationCompletion();
  drifted.approvedExtraction.characters[0].name = '已篡改';
  assert.throws(
    () => task.complete(drifted),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const internallyDangling = createAdaptationCompletion();
  internallyDangling.approvedExtraction.events[0].characterFactIds = ['character-missing'];
  internallyDangling.approval.resultHash = sha256Canonical(internallyDangling.approvedExtraction);
  assert.throws(
    () => task.complete(internallyDangling),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('EpisodeAdaptationTask rejects dangling facts, decisions, and unused decisions', () => {
  const task = createEpisodeAdaptationTask();

  const danglingFact = createValidAdaptationOutput();
  danglingFact.beats[0].factRefs = ['fact-missing'];
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(danglingFact) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const danglingDecision = createValidAdaptationOutput();
  danglingDecision.beats[2].adaptationDecisionRefs = ['decision-missing'];
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(danglingDecision) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const unusedDecision = createValidAdaptationOutput();
  unusedDecision.adaptationDecisions.push({
    ...structuredClone(unusedDecision.adaptationDecisions[0]),
    decisionId: 'decision-unused',
  });
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(unusedDecision) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const duplicateBeat = createValidAdaptationOutput();
  duplicateBeat.beats[1].beatId = duplicateBeat.beats[0].beatId;
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(duplicateBeat) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const duplicateDecision = createValidAdaptationOutput();
  duplicateDecision.adaptationDecisions.push(
    structuredClone(duplicateDecision.adaptationDecisions[0]),
  );
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(duplicateDecision) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );
});

test('EpisodeAdaptationTask enforces the declared one-minute duration budget', () => {
  const task = createEpisodeAdaptationTask();
  const tooShort = createValidAdaptationOutput();
  tooShort.beats[4].estimatedDurationSeconds = 1;
  tooShort.durationSummary.totalSeconds = 51;
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(tooShort) })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );

  const falseSummary = createValidAdaptationOutput();
  falseSummary.durationSummary.totalSeconds = 59;
  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponse: JSON.stringify(falseSummary) })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );

  assert.throws(
    () => task.complete(createAdaptationCompletion({
      durationBudget: { targetSeconds: 10, toleranceSeconds: 5 },
    })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('EpisodeAdaptationTask rejects accessors and non-canonical response references', () => {
  const task = createEpisodeAdaptationTask();
  let getterCalls = 0;
  const input = createAdaptationCompletion();
  Object.defineProperty(input, 'style', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { genre: '武侠', tone: '紧张', audience: '全年龄' };
    },
  });
  assert.throws(
    () => task.complete(input),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
  assert.equal(getterCalls, 0);

  assert.throws(
    () => task.complete(createAdaptationCompletion({ rawResponseRef: 'response:v1:not-a-uuid' })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('script formatting schema is strict and separates ordered actions from dialogue', () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(scriptFormattingSchema);
  const valid = createValidScriptOutput();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const missingDelivery = structuredClone(valid);
  delete missingDelivery.scenes[0].entries[1].emotion;
  assert.equal(validate(missingDelivery), false);

  const freeField = structuredClone(valid);
  freeField.scenes[0].entries[0].providerPrompt = 'forbidden';
  assert.equal(validate(freeField), false);

  const inventedUnmarkedDialogue = structuredClone(valid);
  inventedUnmarkedDialogue.scenes[1].entries[1].adaptationDecisionRefs = [];
  assert.equal(validate(inventedUnmarkedDialogue), false);
});

test('ScriptFormattingTask returns immutable, approved upstream audit metadata', () => {
  const task = createScriptFormattingTask();
  const completion = createScriptCompletion();
  const result = task.complete(completion);

  assert.equal(result.taskType, 'ScriptFormattingTask');
  assert.equal(result.schemaVersion, 'script-formatting.v1');
  assert.equal(result.upstreamExtractionHash, completion.extractionApproval.resultHash);
  assert.equal(result.upstreamAdaptationHash, completion.adaptationApproval.resultHash);
  assert.equal(result.extractionApprovalRef, completion.extractionApproval.reviewRef);
  assert.equal(result.adaptationApprovalRef, completion.adaptationApproval.reviewRef);
  assert.equal(result.output.durationSummary.totalSeconds, 60);
  assert.equal(result.rawResponseSha256, sha256(completion.rawResponse));
  assert.match(result.inputHash, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output.scenes[0].entries[0]), true);
  assert.equal(JSON.stringify(result).includes(completion.rawResponse), false);

  const reordered = createScriptCompletion();
  reordered.adaptationApproval = {
    reviewRef: reordered.adaptationApproval.reviewRef,
    resultHash: reordered.adaptationApproval.resultHash,
    status: 'approved',
  };
  assert.equal(task.complete(reordered).inputHash, result.inputHash);
});

test('ScriptFormattingTask binds adaptation approval to the approved extraction', () => {
  const task = createScriptFormattingTask();
  const driftedApproval = createScriptCompletion();
  driftedApproval.adaptationApproval.resultHash = '0'.repeat(64);
  assert.throws(
    () => task.complete(driftedApproval),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const crossExtraction = createScriptCompletion();
  crossExtraction.extractionApproval.resultHash = '1'.repeat(64);
  assert.throws(
    () => task.complete(crossExtraction),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const forgedInputHash = createScriptCompletion();
  forgedInputHash.adaptationResult = structuredClone(forgedInputHash.adaptationResult);
  forgedInputHash.adaptationResult.inputHash = '2'.repeat(64);
  assert.throws(
    () => task.complete(forgedInputHash),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('ScriptFormattingTask validates typed scene, character, prop, and dialogue facts', () => {
  const task = createScriptFormattingTask();

  const characterAsScene = createValidScriptOutput();
  characterAsScene.scenes[0].sceneFactRef = 'character-zhao-yun';
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(characterAsScene) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const sceneAsCharacter = createValidScriptOutput();
  sceneAsCharacter.scenes[0].characterFactRefs = ['scene-inn'];
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(sceneAsCharacter) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const actionCharacterOutsideScene = createValidScriptOutput();
  actionCharacterOutsideScene.scenes[0].characterFactRefs = ['character-innkeeper'];
  assert.throws(
    () => task.complete(createScriptCompletion({
      rawResponse: JSON.stringify(actionCharacterOutsideScene),
    })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const wrongOriginalDialogue = createValidScriptOutput();
  wrongOriginalDialogue.scenes[0].entries[1].text = '楼上无人。';
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(wrongOriginalDialogue) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const unmarkedAdaptedAction = createValidScriptOutput();
  unmarkedAdaptedAction.scenes[1].entries[0].adaptationDecisionRefs = [];
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(unmarkedAdaptedAction) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const unmarkedAdaptedScene = createValidScriptOutput();
  unmarkedAdaptedScene.scenes[1].adaptationDecisionRefs = [];
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(unmarkedAdaptedScene) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );
});

test('ScriptFormattingTask preserves beat coverage, ordering, and exact timing', () => {
  const task = createScriptFormattingTask();

  const missingBeat = createValidScriptOutput();
  missingBeat.scenes[1].beatRefs = ['beat-stair-confrontation'];
  missingBeat.scenes[1].entries[1].beatRefs = ['beat-stair-confrontation'];
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(missingBeat) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const wrongOrdinal = createValidScriptOutput();
  wrongOrdinal.scenes[1].ordinal = 3;
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(wrongOrdinal) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const sceneTimingDrift = createValidScriptOutput();
  sceneTimingDrift.scenes[0].estimatedDurationSeconds = 34;
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(sceneTimingDrift) })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );

  const totalTimingDrift = createValidScriptOutput();
  totalTimingDrift.durationSummary.totalSeconds = 59;
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(totalTimingDrift) })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );

  const reversedScenes = createValidScriptOutput();
  reversedScenes.scenes.reverse();
  reversedScenes.scenes[0].ordinal = 1;
  reversedScenes.scenes[1].ordinal = 2;
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(reversedScenes) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const duplicateBeat = createValidScriptOutput();
  duplicateBeat.scenes[1].beatRefs.unshift('beat-rainy-arrival');
  duplicateBeat.scenes[1].entries[0].beatRefs.unshift('beat-rainy-arrival');
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponse: JSON.stringify(duplicateBeat) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );
});

test('ScriptFormattingTask requires a decision for unproven interior or exterior headings', () => {
  const task = createScriptFormattingTask();
  const unapprovedExterior = createFactOnlyOpeningScript('EXT');
  assert.throws(
    () => task.complete(createScriptCompletion({
      rawResponse: JSON.stringify(unapprovedExterior),
    })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const unknownHeading = createFactOnlyOpeningScript('UNKNOWN');
  assert.doesNotThrow(() => task.complete(createScriptCompletion({
    rawResponse: JSON.stringify(unknownHeading),
  })));
});

test('ScriptFormattingTask rejects accessors and non-canonical response references', () => {
  const task = createScriptFormattingTask();
  let getterCalls = 0;
  const input = createScriptCompletion();
  Object.defineProperty(input, 'adaptationResult', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return createScriptCompletion().adaptationResult;
    },
  });
  assert.throws(
    () => task.complete(input),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => task.complete(createScriptCompletion({ rawResponseRef: 'response:v1:invalid' })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('shot planning schema requires four to six ordered production shots', () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(shotPlanningSchema);
  const valid = createValidShotPlanningOutput();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const tooFew = structuredClone(valid);
  tooFew.shots = tooFew.shots.slice(0, 3);
  assert.equal(validate(tooFew), false);

  const unknownField = structuredClone(valid);
  unknownField.shots[0].providerPrompt = 'vendor syntax';
  assert.equal(validate(unknownField), false);

  const wrongAspectRatio = structuredClone(valid);
  wrongAspectRatio.aspectRatio = '9:16';
  assert.equal(validate(wrongAspectRatio), false);
});

test('ShotPlanningTask returns immutable audit metadata bound to the approved script', () => {
  const completion = createShotPlanningCompletion();
  const result = createShotPlanningTask().complete(completion);
  assert.equal(result.taskType, 'ShotPlanningTask');
  assert.equal(result.schemaVersion, 'shot-planning.v1');
  assert.equal(result.upstreamScriptHash, completion.scriptApproval.resultHash);
  assert.equal(result.scriptApprovalRef, completion.scriptApproval.reviewRef);
  assert.equal(result.assetCatalogHash, sha256Canonical(completion.assetVersions));
  assert.equal(result.inputHash, sha256Canonical({
    assetVersions: completion.assetVersions,
    adaptationApproval: completion.adaptationApproval,
    adaptationResult: completion.adaptationResult,
    approvedExtraction: completion.approvedExtraction,
    extractionApproval: completion.extractionApproval,
    scriptApproval: completion.scriptApproval,
    scriptResult: completion.scriptResult,
  }));
  assert.equal(result.output.durationSummary.totalSeconds, 60);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output.shots[0].continuity), true);
});

test('ShotPlanningTask requires the exact approved script result', () => {
  const mismatchedApproval = createShotPlanningCompletion();
  mismatchedApproval.scriptApproval.resultHash = '0'.repeat(64);
  assert.throws(
    () => createShotPlanningTask().complete(mismatchedApproval),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const mutatedResult = createShotPlanningCompletion();
  mutatedResult.scriptResult = structuredClone(mutatedResult.scriptResult);
  mutatedResult.scriptResult.output.scenes[0].purpose = '被篡改';
  assert.throws(
    () => createShotPlanningTask().complete(mutatedResult),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const wrongScriptInputHash = createShotPlanningCompletion();
  wrongScriptInputHash.scriptResult = structuredClone(wrongScriptInputHash.scriptResult);
  wrongScriptInputHash.scriptResult.inputHash = '0'.repeat(64);
  assert.throws(
    () => createShotPlanningTask().complete(wrongScriptInputHash),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const wrongUpstreamApproval = createShotPlanningCompletion();
  wrongUpstreamApproval.adaptationApproval.resultHash = '0'.repeat(64);
  assert.throws(
    () => createShotPlanningTask().complete(wrongUpstreamApproval),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );

  const internallyInvalid = createShotPlanningCompletion();
  internallyInvalid.scriptResult = structuredClone(internallyInvalid.scriptResult);
  internallyInvalid.scriptResult.output.scenes[0].beatRefs.push('beat-orphan');
  internallyInvalid.scriptApproval.resultHash = sha256Canonical(
    internallyInvalid.scriptResult.output,
  );
  assert.throws(
    () => createShotPlanningTask().complete(internallyInvalid),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('ShotPlanningTask rejects a self-signed cross-scene duplicate beat', () => {
  const forged = createShotPlanningCompletion();
  forged.scriptResult = structuredClone(forged.scriptResult);
  forged.scriptResult.output.scenes[1].beatRefs.unshift('beat-rainy-arrival');
  forged.scriptResult.output.scenes[1].entries[0].beatRefs.unshift('beat-rainy-arrival');
  forged.scriptApproval.resultHash = sha256Canonical(forged.scriptResult.output);
  assert.throws(
    () => createShotPlanningTask().complete(forged),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('ShotPlanningTask rejects a self-signed replacement of an approved beat identity', () => {
  const forged = createShotPlanningCompletion();
  forged.scriptResult = structuredClone(forged.scriptResult);
  forged.scriptResult.output.scenes[0].beatRefs[0] = 'beat-forged';
  forged.scriptResult.output.scenes[0].entries[0].beatRefs[0] = 'beat-forged';
  forged.scriptApproval.resultHash = sha256Canonical(forged.scriptResult.output);
  assert.throws(
    () => createShotPlanningTask().complete(forged),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('ShotPlanningTask validates scene, entry, dialogue, character and asset references', () => {
  const task = createShotPlanningTask();
  for (const mutate of [
    (output) => { output.shots[0].sceneId = 'missing-scene'; },
    (output) => { output.shots[0].entryRefs = ['missing-entry']; },
    (output) => { output.shots[0].characterFactRefs = ['character-innkeeper']; },
    (output) => { output.shots[1].dialogueEntryRefs = []; },
    (output) => {
      output.shots[0].assetVersionRefs = [
        'asset-version:v1:20000000-0000-4000-8000-000000000099',
      ];
    },
    (output) => {
      output.shots[0].assetVersionRefs.push(
        'asset-version:v1:20000000-0000-4000-8000-000000000004',
      );
    },
  ]) {
    const output = createValidShotPlanningOutput();
    mutate(output);
    assert.throws(
      () => task.complete(createShotPlanningCompletion({ rawResponse: JSON.stringify(output) })),
      assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
    );
  }
});

test('ShotPlanningTask preserves ordered entry coverage while allowing a contiguous split', () => {
  const task = createShotPlanningTask();
  const split = createValidShotPlanningOutput();
  const continuation = structuredClone(split.shots[0]);
  continuation.shotId = 'shot-rainy-arrival-continuation';
  continuation.durationSeconds = 7;
  continuation.continuity.transitionFromPrevious = 'cut';
  continuation.continuity.axisStrategy = 'maintain';
  split.shots[0].durationSeconds = 6;
  split.shots.splice(1, 0, continuation);
  split.shots.forEach((item, index) => { item.ordinal = index + 1; });
  assert.doesNotThrow(() => task.complete(createShotPlanningCompletion({
    rawResponse: JSON.stringify(split),
  })));

  const backwards = createValidShotPlanningOutput();
  backwards.shots[2].entryRefs = ['entry-arrival-action'];
  backwards.shots[2].characterFactRefs = ['character-zhao-yun'];
  backwards.shots[2].assetVersionRefs.push(
    'asset-version:v1:20000000-0000-4000-8000-000000000003',
  );
  assert.throws(
    () => task.complete(createShotPlanningCompletion({ rawResponse: JSON.stringify(backwards) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const missing = createValidShotPlanningOutput();
  missing.shots[2].entryRefs = ['entry-upstairs-dialogue'];
  missing.shots[2].dialogueEntryRefs = ['entry-upstairs-dialogue'];
  missing.shots[2].characterFactRefs = ['character-innkeeper'];
  missing.shots[2].assetVersionRefs.push(
    'asset-version:v1:20000000-0000-4000-8000-000000000004',
  );
  assert.throws(
    () => task.complete(createShotPlanningCompletion({ rawResponse: JSON.stringify(missing) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );
});

test('ShotPlanningTask preserves scene and total timing exactly', () => {
  const task = createShotPlanningTask();
  const crossSceneDrift = createValidShotPlanningOutput();
  crossSceneDrift.shots[0].durationSeconds -= 1;
  crossSceneDrift.shots[3].durationSeconds += 1;
  assert.throws(
    () => task.complete(createShotPlanningCompletion({ rawResponse: JSON.stringify(crossSceneDrift) })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );

  const totalDrift = createValidShotPlanningOutput();
  totalDrift.shots[0].durationSeconds -= 1;
  totalDrift.durationSummary.totalSeconds = 59;
  assert.throws(
    () => task.complete(createShotPlanningCompletion({ rawResponse: JSON.stringify(totalDrift) })),
    assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
  );
});

test('ShotPlanningTask enforces transition and screen-axis continuity', () => {
  const task = createShotPlanningTask();
  const badStart = createValidShotPlanningOutput();
  badStart.shots[0].continuity.transitionFromPrevious = 'cut';
  assert.throws(
    () => task.complete(createShotPlanningCompletion({ rawResponse: JSON.stringify(badStart) })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const unmarkedAxisCross = createValidShotPlanningOutput();
  unmarkedAxisCross.shots[1].continuity.screenDirection = 'right_to_left';
  assert.throws(
    () => task.complete(createShotPlanningCompletion({
      rawResponse: JSON.stringify(unmarkedAxisCross),
    })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );

  const sceneWithoutEstablish = createValidShotPlanningOutput();
  sceneWithoutEstablish.shots[3].continuity.axisStrategy = 'maintain';
  assert.throws(
    () => task.complete(createShotPlanningCompletion({
      rawResponse: JSON.stringify(sceneWithoutEstablish),
    })),
    assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
  );
});

test('ShotPlanningTask rejects hostile inputs and non-canonical response references', () => {
  const task = createShotPlanningTask();
  let getterCalls = 0;
  const input = createShotPlanningCompletion();
  Object.defineProperty(input, 'assetVersions', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return createAssetVersions();
    },
  });
  assert.throws(() => task.complete(input), assertTaskError('NARRATIVE_TASK_INPUT_INVALID'));
  assert.equal(getterCalls, 0);
  assert.throws(
    () => task.complete(createShotPlanningCompletion({ rawResponseRef: 'response:v1:invalid' })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});

test('prompt semantic schema is strict and contains only provider-neutral shot semantics', () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(promptSemanticSchema);
  const valid = createValidPromptSemanticOutput();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const providerField = structuredClone(valid);
  providerField.semanticShots[0].providerPrompt = '--ar 16:9';
  assert.equal(validate(providerField), false);

  const workflowField = structuredClone(valid);
  workflowField.semanticShots[0].lighting.sampler = 'euler';
  assert.equal(validate(workflowField), false);
});

test('PromptSemanticTask returns immutable semantics bound to the approved shot plan', () => {
  const completion = createPromptSemanticCompletion();
  const result = createPromptSemanticTask().complete(completion);
  assert.equal(result.taskType, 'PromptSemanticTask');
  assert.equal(result.schemaVersion, 'prompt-semantic.v1');
  assert.equal(result.upstreamShotHash, completion.shotPlanningApproval.resultHash);
  assert.equal(result.shotApprovalRef, completion.shotPlanningApproval.reviewRef);
  assert.equal(result.assetCatalogHash, sha256Canonical(completion.assetVersions));
  assert.equal(result.inputHash, sha256Canonical({
    approvedExtraction: completion.approvedExtraction,
    extractionApproval: completion.extractionApproval,
    adaptationResult: completion.adaptationResult,
    adaptationApproval: completion.adaptationApproval,
    scriptResult: completion.scriptResult,
    scriptApproval: completion.scriptApproval,
    assetVersions: completion.assetVersions,
    shotPlanningResult: completion.shotPlanningResult,
    shotPlanningApproval: completion.shotPlanningApproval,
  }));
  assert.equal(result.output.semanticShots.length, 5);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output.semanticShots[0].lighting), true);
  assert.equal(JSON.stringify(result).includes(completion.rawResponse), false);
});

test('PromptSemanticTask requires the exact approved shot chain and typed asset mapping', () => {
  const task = createPromptSemanticTask();

  const badApproval = createPromptSemanticCompletion();
  badApproval.shotPlanningApproval.resultHash = '0'.repeat(64);
  assert.throws(() => task.complete(badApproval), assertTaskError('NARRATIVE_TASK_INPUT_INVALID'));

  const forgedInput = createPromptSemanticCompletion();
  forgedInput.shotPlanningResult = structuredClone(forgedInput.shotPlanningResult);
  forgedInput.shotPlanningResult.inputHash = '0'.repeat(64);
  forgedInput.shotPlanningApproval.resultHash = sha256Canonical(
    forgedInput.shotPlanningResult.output,
  );
  assert.throws(() => task.complete(forgedInput), assertTaskError('NARRATIVE_TASK_INPUT_INVALID'));

  for (const mutate of [
    (output) => { output.semanticShots[0].shotId = 'shot-forged'; },
    (output) => { output.semanticShots[0].durationSeconds += 1; },
    (output) => { output.semanticShots[0].subjects.characterFactRefs = []; },
    (output) => { output.semanticShots[0].subjects.characterAssetVersionRefs = []; },
    (output) => { output.semanticShots[0].environment.sceneAssetVersionRefs = []; },
    (output) => { output.semanticShots[0].camera.shotSize = 'CU'; },
    (output) => { output.semanticShots[0].continuity.axisStrategy = 'maintain'; },
  ]) {
    const output = createValidPromptSemanticOutput();
    mutate(output);
    assert.throws(
      () => task.complete(createPromptSemanticCompletion({ rawResponse: JSON.stringify(output) })),
      assertTaskError('NARRATIVE_TASK_REFERENCE_INVALID'),
    );
  }
});

test('PromptSemanticTask binds the complete approved shot result envelope', () => {
  const task = createPromptSemanticTask();
  for (const mutate of [
    (result) => { result.model.name = 'tampered-model'; },
    (result) => { result.parameters.temperature = 1; },
    (result) => {
      result.rawResponseRef = 'response:v1:10000000-0000-4000-8000-000000000099';
    },
    (result) => { result.rawResponseSha256 = '0'.repeat(64); },
  ]) {
    const completion = createPromptSemanticCompletion();
    completion.shotPlanningResult = structuredClone(completion.shotPlanningResult);
    mutate(completion.shotPlanningResult);
    assert.throws(
      () => task.complete(completion),
      assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
    );
  }
});

test('PromptSemanticTask rejects Provider and workflow syntax inside semantic text', () => {
  const task = createPromptSemanticTask();
  for (const forbidden of [
    '--ar 16:9 --stylize 200',
    '-- ar 16:9',
    '<lora:hero:0.8>',
    'KSampler cfg_scale=7 steps=20',
    '{"class_type":"CheckpointLoaderSimple"}',
    'https://provider.example/workflow.json',
    'ComfyUI workflow node 12',
    'MID-JOURNEY cinematic preset',
    'negative_prompt: low quality',
    'load /home/fixture-user/models/hero.safetensors',
    String.raw`load D:\models\hero.safetensors`,
    'CFG scale 7',
    'steps 20 seed 42 denoise 0.8 sampler Euler',
    's3://bucket/models/hero',
    '载入s3://bucket/models/hero',
    '载入/home/fixture-user/models/hero',
    'load ./models/hero',
    'load ../models/hero',
    '载入./models/hero',
    String.raw`load C : \models\hero`,
    String.raw`载入C : \models\hero`,
    'C F G scale 7',
    'sampler DPM++ 2M Karras',
    'steps_20',
    'steps-20',
    'seed_42',
    'cfg-scale-7',
    'denoise .8',
    'sampler_name Euler',
    'sampler-name DPM++ 2M',
    'scheduler_karras',
    'DPM++ 2M Karras',
    'use Runway for video generation',
    'Runway prompt for this shot',
    '可灵风格生成',
    '即梦风格提示词',
    'load /secret',
    String.raw`load \models\hero`,
    'load model.gguf',
    'width_1920 height 1080 px',
    'guidance-scale: 7',
    'load /private/model',
    String.raw`\models\hero`,
    'weights.safetensors',
    'generated with Runway',
    'Kling video model',
    'steps__20',
    'denoise 1e-1',
    'sampler_name__euler',
    'sampler dpmpp_2m',
    'sampler euler_ancestral',
    'scheduler ddim_uniform',
    'DPM++_2M_Karras',
    'generated with Stable Diffusion',
    'generated with Mid Journey',
    'Runway AI video',
    '通过可灵制作视频',
    '由即梦制作画面',
    'data:image/png;base64,AAAA',
    'mailto:user@example.com',
    'load ~/private/hero',
    String.raw`load %USERPROFILE%\private\hero`,
    'load "/private/hero"',
    'weights.tflite',
    'model.pb',
    'Runway AI',
    String.raw`load $HOME/private/hero`,
    'load ${HOME}/private/hero',
    String.raw`load $env:USERPROFILE\private\hero`,
    'load config.toml',
    'lora strength 0.8',
    'embedding:hero',
    'sampler custom_algo',
    'scheduler:custom',
    'steps 20',
    'width 1920',
    'height 1080',
    'steps–20',
    'steps−20',
    'ssh:user@example.com',
    'git:models/hero',
    'ipfs:QmExampleCid',
    '载入$HOME/private/hero',
    'powered by Stable Diffusion',
    'powered by Runway',
    'powered by Kling',
    '采用可灵出图',
    '采用即梦出图',
    'CFG scale7',
    'steps20',
    'seed42',
    'denoise0.8',
    'sampler customFlux',
    'scheduler mystery',
    '连接ssh:user@host',
    '采用 Runway 制作镜头',
    '借助 Kling 制作视频',
    '采用 Stable Diffusion 制作画面',
    'Use sampler customFlux for render',
    'Set scheduler mystery for generation',
    'camera uses sampler customFlux',
    'Pick sampler customFlux',
    'Switch scheduler FlowMatch2',
    'Enable sampler customFlux',
    'Change sampler Nova2',
    'Assign scheduler customFlux',
    'render with sampler customFlux',
    'generate with scheduler mystery',
    'sampler customFlux for inference',
    'Use Stable Diffusion to generate the shot',
    'using Stable Diffusion to create the image',
    'Use Mid Journey to generate the shot',
    'Use Runway to generate video',
    'Use sampler mystery',
    'Set scheduler mystery',
    'Choose sampler mystery',
    'sampler mystery!',
    'scheduler mystery。',
    'sampler mystery!!',
    'scheduler mystery！？',
    'sampler mystery !',
    'ＣＦＧ　ｓｃａｌｅ　７',
    '使用可灵模型生成画面',
    'Runway Gen-3 model preset',
  ]) {
    const output = createValidPromptSemanticOutput();
    output.semanticShots[0].lighting.description = forbidden;
    assert.throws(
      () => task.complete(createPromptSemanticCompletion({ rawResponse: JSON.stringify(output) })),
      assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
    );
  }
});

test('PromptSemanticTask applies Provider-neutral validation to every free-text field', () => {
  const task = createPromptSemanticTask();
  const forbidden = 'sampler mystery!!';
  const cases = [
    {
      semantic: (shot) => { shot.subjects.description = forbidden; },
    },
    {
      semantic: (shot) => { shot.environment.description = forbidden; },
    },
    {
      semantic: (shot) => { shot.action = forbidden; },
      planned: (shot) => { shot.action = forbidden; },
    },
    {
      semantic: (shot) => { shot.camera.composition = forbidden; },
      planned: (shot) => { shot.composition = forbidden; },
    },
    {
      semantic: (shot) => { shot.lighting.description = forbidden; },
    },
    {
      semantic: (shot) => { shot.continuity.notes = forbidden; },
      planned: (shot) => { shot.continuity.notes = forbidden; },
    },
  ];
  for (const item of cases) {
    const completion = createPromptSemanticCompletion();
    const output = createValidPromptSemanticOutput();
    item.semantic(output.semanticShots[0]);
    if (item.planned) {
      completion.shotPlanningResult = structuredClone(completion.shotPlanningResult);
      item.planned(completion.shotPlanningResult.output.shots[0]);
      completion.shotPlanningApproval.resultHash = sha256Canonical(
        completion.shotPlanningResult.output,
      );
      completion.shotPlanningApproval.envelopeHash = sha256Canonical(
        completion.shotPlanningResult,
      );
    }
    completion.rawResponse = JSON.stringify(output);
    assert.throws(
      () => task.complete(completion),
      assertTaskError('NARRATIVE_TASK_RESPONSE_INVALID'),
    );
  }
});

test('PromptSemanticTask preserves ordinary words that overlap Provider brands', () => {
  const task = createPromptSemanticTask();
  for (const ordinary of [
    '镜头可灵活跟随人物移动。',
    'The camera follows the actor across the runway.',
    'The hero steps into frame while the camera remains stable.',
    'Twinkling lights reflect across the wet street.',
    'Sparkling rain catches the backlight.',
    'The seed: a symbol of hope, rests in her palm.',
    'The model: a young woman, turns toward camera.',
    'The wall height 3 meters emphasizes confinement.',
    'The prop width 20 centimeters remains consistent.',
    'Steps: the actor enters and pauses.',
    'The actor steps 20 paces before stopping.',
    'A stable diffusion of window light softens the shadows.',
    'The traveler pauses mid-journey beneath the bridge.',
    'Embedding the blade into the wooden post, he steps back.',
    'Lora turns toward the window as dawn light enters.',
    'The checkpoint guards wave the car through.',
    'The checkpoint remains empty beneath cold rain.',
    'The building height 3 stories emphasizes isolation.',
    'The corridor width 4 yards compresses the crowd.',
    'The sign marked Seed 42 hangs above the door.',
    'Seed 42',
    'Kling enters the room and closes the door.',
    'The sampler collects soil beside the river.',
    'The scheduler waits beside the production board.',
    'Embedding the blade into the model ship, he steps back.',
    'Lora watches the fashion model cross the room.',
    'The runway passes a model aircraft near the hangar.',
    'Kling walks past the video store before dawn.',
    'The room width 4 yards and height 3 stories emphasizes confinement.',
    'The wall has width 3 m and height 2 m.',
    'A runway model walks beneath warm practical lights.',
    'Sampler John collects soil beside the river.',
    'Scheduler Alice waits beside the board.',
    '借助Klingon角色制作冲突场面。',
    '采用runwayman的动作制作广告。',
    'We use stable diffusion of window light to soften shadows.',
    'We select sampler John for the field crew.',
    'Choose scheduler Alice for the production team.',
    'Setting the sampler basket beside the river, she steps back.',
    'Sampler John.',
    'Scheduler Alice.',
    'We select sampler John.',
    'Choose scheduler Alice.',
    'Workers use the runway to create a safe evacuation route.',
    'The camera uses the runway to create strong leading lines.',
    'The aircraft taxis via runway 2 at dawn.',
    'The plane accelerates using the runway before takeoff.',
    '通过可灵活调整的镜头运动保持主体居中。',
    '由可灵活移动的侧光勾勒人物轮廓。',
  ]) {
    const output = createValidPromptSemanticOutput();
    output.semanticShots[0].lighting.description = ordinary;
    assert.doesNotThrow(
      () => task.complete(createPromptSemanticCompletion({ rawResponse: JSON.stringify(output) })),
    );
  }
});

test('PromptSemanticTask rejects hostile inputs and non-canonical response references', () => {
  const task = createPromptSemanticTask();
  let getterCalls = 0;
  const input = createPromptSemanticCompletion();
  Object.defineProperty(input, 'shotPlanningResult', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return createPromptSemanticCompletion().shotPlanningResult;
    },
  });
  assert.throws(() => task.complete(input), assertTaskError('NARRATIVE_TASK_INPUT_INVALID'));
  assert.equal(getterCalls, 0);
  assert.throws(
    () => task.complete(createPromptSemanticCompletion({ rawResponseRef: 'response:v1:invalid' })),
    assertTaskError('NARRATIVE_TASK_INPUT_INVALID'),
  );
});
