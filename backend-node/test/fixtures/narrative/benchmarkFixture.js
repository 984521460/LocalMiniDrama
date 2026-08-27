const DURATION_BUDGET = Object.freeze({ targetSeconds: 60, toleranceSeconds: 5 });
const STYLE = Object.freeze({ genre: '武侠', tone: '紧张', audience: '全年龄' });

function fixtureUid(number) {
  return `70000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function evidenceFor(blocks, quote) {
  for (const block of blocks) {
    const text = Array.from(block.text);
    const quotePoints = Array.from(quote);
    const startOffset = text.join('').indexOf(quote);
    if (startOffset < 0) continue;
    const codePointStart = codePointLength(block.text.slice(0, startOffset));
    return {
      blockUid: block.uid,
      startOffset: codePointStart,
      endOffset: codePointStart + quotePoints.length,
      quote,
    };
  }
  throw new Error('benchmark evidence quote is missing');
}

function createExtractionOutput(blocks) {
  return {
    schemaVersion: 'novel-extraction.v1',
    characters: [
      {
        factId: 'character-zhao-yun',
        name: '赵云',
        description: '雨夜进入客栈的人',
        evidence: [evidenceFor(blocks, '赵云')],
      },
      {
        factId: 'character-innkeeper',
        name: '掌柜',
        description: '告知楼上有人的掌柜',
        evidence: [evidenceFor(blocks, '掌柜')],
      },
    ],
    scenes: [{
      factId: 'scene-inn',
      location: '客栈',
      time: '雨夜',
      description: '雨夜的客栈',
      evidence: [evidenceFor(blocks, '雨夜')],
    }],
    props: [],
    relationships: [],
    events: [{
      factId: 'event-enter-inn',
      summary: '赵云在雨夜进入客栈',
      characterFactIds: ['character-zhao-yun'],
      sceneFactId: 'scene-inn',
      propFactIds: [],
      evidence: [evidenceFor(blocks, '赵云在雨夜进入客栈')],
    }],
    dialogue: [{
      factId: 'dialogue-upstairs',
      speakerCharacterFactId: 'character-innkeeper',
      content: '楼上有人。',
      evidence: [evidenceFor(blocks, '楼上有人。')],
    }],
  };
}

function createAdaptationOutput() {
  return {
    schemaVersion: 'episode-adaptation.v1',
    durationSummary: { ...DURATION_BUDGET, totalSeconds: 60 },
    beats: [
      {
        beatId: 'beat-rainy-arrival', kind: 'hook', summary: '赵云冒雨进入客栈。',
        classification: 'fact', inferenceRationale: null, estimatedDurationSeconds: 8,
        factRefs: ['event-enter-inn'], adaptationDecisionRefs: [],
      },
      {
        beatId: 'beat-tense-inn', kind: 'setup', summary: '雨夜客栈显得格外紧张。',
        classification: 'inference', inferenceRationale: '由雨夜与陌生客栈环境推断紧张气氛。',
        estimatedDurationSeconds: 12, factRefs: ['scene-inn'], adaptationDecisionRefs: [],
      },
      {
        beatId: 'beat-upstairs-warning', kind: 'escalation', summary: '掌柜的警告引出楼上追兵。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 15,
        factRefs: ['dialogue-upstairs'], adaptationDecisionRefs: ['decision-add-pursuer'],
      },
      {
        beatId: 'beat-stair-confrontation', kind: 'climax', summary: '赵云冲上楼与追兵正面对峙。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 15,
        factRefs: ['character-zhao-yun'], adaptationDecisionRefs: ['decision-add-pursuer'],
      },
      {
        beatId: 'beat-hidden-identity', kind: 'cliffhanger', summary: '追兵说出赵云不该知道的秘密。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 10,
        factRefs: ['character-zhao-yun'], adaptationDecisionRefs: ['decision-add-pursuer'],
      },
    ],
    adaptationDecisions: [{
      decisionId: 'decision-add-pursuer',
      classification: 'adaptation',
      category: 'invented-event',
      summary: '新增楼上追兵与对峙。',
      rationale: '把原文警告转成一分钟单集的升级、高潮和悬念。',
      factRefs: ['character-zhao-yun', 'dialogue-upstairs'],
    }],
  };
}

function createScriptOutput() {
  return {
    schemaVersion: 'script-formatting.v1',
    durationSummary: { totalSeconds: 60 },
    scenes: [
      {
        sceneId: 'script-scene-inn-floor', ordinal: 1,
        heading: { interiorExterior: 'INT', location: '客栈', time: '雨夜' },
        purpose: '建立雨夜客栈与楼上威胁。', sceneFactRef: 'scene-inn',
        characterFactRefs: ['character-zhao-yun', 'character-innkeeper'], propFactRefs: [],
        beatRefs: ['beat-rainy-arrival', 'beat-tense-inn', 'beat-upstairs-warning'],
        adaptationDecisionRefs: ['decision-add-pursuer'], estimatedDurationSeconds: 35,
        entries: [
          {
            entryId: 'entry-arrival-action', type: 'action', text: '赵云推门进入雨夜中的客栈。',
            characterFactRefs: ['character-zhao-yun'], propFactRefs: [],
            beatRefs: ['beat-rainy-arrival', 'beat-tense-inn'], adaptationDecisionRefs: [],
            durationSeconds: 13,
          },
          {
            entryId: 'entry-upstairs-dialogue', type: 'dialogue',
            speakerCharacterFactId: 'character-innkeeper', dialogueFactRef: 'dialogue-upstairs',
            text: '楼上有人。', emotion: '警惕', speechRateWordsPerMinute: 120,
            narrativePurpose: 'escalation', beatRefs: ['beat-upstairs-warning'],
            adaptationDecisionRefs: [], durationSeconds: 7,
          },
          {
            entryId: 'entry-upstairs-reveal', type: 'action', text: '楼板传来追兵逼近的脚步声。',
            characterFactRefs: [], propFactRefs: [], beatRefs: ['beat-upstairs-warning'],
            adaptationDecisionRefs: ['decision-add-pursuer'], durationSeconds: 15,
          },
        ],
      },
      {
        sceneId: 'script-scene-inn-upstairs', ordinal: 2,
        heading: { interiorExterior: 'INT', location: '客栈', time: '雨夜' },
        purpose: '完成对峙并留下身份悬念。', sceneFactRef: 'scene-inn',
        characterFactRefs: ['character-zhao-yun'], propFactRefs: [],
        beatRefs: ['beat-stair-confrontation', 'beat-hidden-identity'],
        adaptationDecisionRefs: ['decision-add-pursuer'], estimatedDurationSeconds: 25,
        entries: [
          {
            entryId: 'entry-stair-action', type: 'action', text: '赵云冲上楼，与追兵隔着长廊对峙。',
            characterFactRefs: ['character-zhao-yun'], propFactRefs: [],
            beatRefs: ['beat-stair-confrontation'], adaptationDecisionRefs: ['decision-add-pursuer'],
            durationSeconds: 15,
          },
          {
            entryId: 'entry-secret-dialogue', type: 'dialogue',
            speakerCharacterFactId: null, dialogueFactRef: null, text: '你终于来了。',
            emotion: '冷峻', speechRateWordsPerMinute: 100, narrativePurpose: 'cliffhanger',
            beatRefs: ['beat-hidden-identity'], adaptationDecisionRefs: ['decision-add-pursuer'],
            durationSeconds: 10,
          },
        ],
      },
    ],
  };
}

function createAssetVersions() {
  return [
    { assetVersionRef: `asset-version:v1:${fixtureUid(101)}`, assetType: 'scene', bindingRef: 'script-scene-inn-floor' },
    { assetVersionRef: `asset-version:v1:${fixtureUid(102)}`, assetType: 'scene', bindingRef: 'script-scene-inn-upstairs' },
    { assetVersionRef: `asset-version:v1:${fixtureUid(103)}`, assetType: 'character', bindingRef: 'character-zhao-yun' },
    { assetVersionRef: `asset-version:v1:${fixtureUid(104)}`, assetType: 'character', bindingRef: 'character-innkeeper' },
  ];
}

function shot(input) {
  return {
    shotId: input.shotId,
    ordinal: input.ordinal,
    sceneId: input.sceneId,
    entryRefs: [input.entryRef],
    durationSeconds: input.durationSeconds,
    shotSize: input.shotSize,
    cameraAngle: input.cameraAngle,
    cameraMovement: input.cameraMovement,
    composition: '16:9 真人影视写实构图。',
    action: input.action,
    characterFactRefs: input.characterFactRefs || [],
    propFactRefs: [],
    dialogueEntryRefs: input.dialogueEntryRefs || [],
    assetVersionRefs: input.assetVersionRefs,
    continuity: {
      transitionFromPrevious: input.transitionFromPrevious,
      screenDirection: input.screenDirection,
      axisStrategy: input.axisStrategy,
      notes: '保持人物朝向、视线与场景空间连续。',
    },
  };
}

function createShotOutput() {
  const [floor, upstairs, zhao, innkeeper] = createAssetVersions().map((asset) => asset.assetVersionRef);
  return {
    schemaVersion: 'shot-planning.v1',
    aspectRatio: '16:9',
    durationSummary: { totalSeconds: 60 },
    shots: [
      shot({
        shotId: 'shot-rainy-arrival', ordinal: 1, sceneId: 'script-scene-inn-floor',
        entryRef: 'entry-arrival-action', durationSeconds: 13, shotSize: 'MS',
        cameraAngle: 'eye_level', cameraMovement: 'dolly', action: '跟随赵云推门进入客栈。',
        characterFactRefs: ['character-zhao-yun'], assetVersionRefs: [floor, zhao],
        transitionFromPrevious: 'start', screenDirection: 'left_to_right', axisStrategy: 'establish',
      }),
      shot({
        shotId: 'shot-innkeeper-warning', ordinal: 2, sceneId: 'script-scene-inn-floor',
        entryRef: 'entry-upstairs-dialogue', durationSeconds: 7, shotSize: 'CU',
        cameraAngle: 'eye_level', cameraMovement: 'static', action: '切至掌柜警惕地发出警告。',
        characterFactRefs: ['character-innkeeper'], dialogueEntryRefs: ['entry-upstairs-dialogue'],
        assetVersionRefs: [floor, innkeeper], transitionFromPrevious: 'cut',
        screenDirection: 'left_to_right', axisStrategy: 'maintain',
      }),
      shot({
        shotId: 'shot-footsteps-reveal', ordinal: 3, sceneId: 'script-scene-inn-floor',
        entryRef: 'entry-upstairs-reveal', durationSeconds: 15, shotSize: 'LS',
        cameraAngle: 'low', cameraMovement: 'tilt', action: '镜头沿楼梯上仰，脚步声逐渐逼近。',
        assetVersionRefs: [floor], transitionFromPrevious: 'cut',
        screenDirection: 'left_to_right', axisStrategy: 'maintain',
      }),
      shot({
        shotId: 'shot-stair-confrontation', ordinal: 4, sceneId: 'script-scene-inn-upstairs',
        entryRef: 'entry-stair-action', durationSeconds: 15, shotSize: 'MLS',
        cameraAngle: 'low', cameraMovement: 'handheld', action: '赵云冲上楼，在长廊中停步对峙。',
        characterFactRefs: ['character-zhao-yun'], assetVersionRefs: [upstairs, zhao],
        transitionFromPrevious: 'cut', screenDirection: 'right_to_left', axisStrategy: 'establish',
      }),
      shot({
        shotId: 'shot-hidden-identity', ordinal: 5, sceneId: 'script-scene-inn-upstairs',
        entryRef: 'entry-secret-dialogue', durationSeconds: 10, shotSize: 'CU',
        cameraAngle: 'eye_level', cameraMovement: 'dolly', action: '缓慢推进赵云的反应，画外音留下悬念。',
        characterFactRefs: ['character-zhao-yun'], dialogueEntryRefs: ['entry-secret-dialogue'],
        assetVersionRefs: [upstairs, zhao], transitionFromPrevious: 'cut',
        screenDirection: 'right_to_left', axisStrategy: 'maintain',
      }),
    ],
  };
}

function createPromptOutput() {
  const plan = createShotOutput();
  const assets = new Map(createAssetVersions().map((asset) => [asset.assetVersionRef, asset]));
  return {
    schemaVersion: 'prompt-semantic.v1',
    aspectRatio: plan.aspectRatio,
    durationSummary: { ...plan.durationSummary },
    semanticShots: plan.shots.map((plannedShot) => {
      const refsOfType = (type) => plannedShot.assetVersionRefs.filter(
        (ref) => assets.get(ref)?.assetType === type,
      );
      return {
        shotId: plannedShot.shotId,
        ordinal: plannedShot.ordinal,
        durationSeconds: plannedShot.durationSeconds,
        subjects: {
          characterFactRefs: [...plannedShot.characterFactRefs],
          characterAssetVersionRefs: refsOfType('character'),
          description: plannedShot.characterFactRefs.length
            ? '人物外观遵循已批准角色资产，姿态服务于当前动作。'
            : '画面以环境和动作线索为主体，不新增人物。',
        },
        environment: {
          sceneId: plannedShot.sceneId,
          sceneAssetVersionRefs: refsOfType('scene'),
          propFactRefs: [...plannedShot.propFactRefs],
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
          quality: 'soft', direction: 'side', colorTemperature: 'cool',
          description: '雨夜冷色侧光，人物面部保持可辨识层次。',
        },
        continuity: { ...plannedShot.continuity },
      };
    }),
  };
}

function completionMetadata(stage, responseNumber, output) {
  return {
    promptVersion: `${stage}.prompt.v1`,
    model: { provider: 'fixture', name: 'benchmark-model' },
    parameters: { temperature: 0, responseFormat: 'json' },
    rawResponseRef: `response:v1:${fixtureUid(responseNumber)}`,
    rawResponse: JSON.stringify(output),
  };
}

module.exports = Object.freeze({
  DURATION_BUDGET,
  STYLE,
  codePointLength,
  completionMetadata,
  createAdaptationOutput,
  createAssetVersions,
  createExtractionOutput,
  createPromptOutput,
  createScriptOutput,
  createShotOutput,
});
