'use strict';

const DURATION_BUDGET = Object.freeze({ targetSeconds: 60, toleranceSeconds: 5 });
const STYLE = Object.freeze({ genre: '悬疑', tone: '紧张', audience: '全年龄' });

function evidence(blocks, quote) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const unitStart = block.text.indexOf(quote);
    if (unitStart < 0) continue;
    if (block.text.lastIndexOf(quote) !== unitStart) {
      throw new TypeError('Rain Before Clear narrative evidence is ambiguous');
    }
    const startOffset = Array.from(block.text.slice(0, unitStart)).length;
    return Object.freeze({
      blockUid: block.uid,
      startOffset,
      endOffset: startOffset + Array.from(quote).length,
      quote,
    });
  }
  throw new TypeError('Rain Before Clear narrative evidence is missing');
}

function createRainExtractionOutput(blocks) {
  const linChe = evidence(blocks, '林澈抱着一只银色证物箱冲进站内');
  const xiaXian = evidence(blocks, '她在停摆的钟下看见调查员夏弦');
  const station = evidence(blocks, '旧车站突然断电');
  const caseEvidence = evidence(blocks, '一只银色证物箱');
  const partnership = evidence(blocks, '夏弦低声提醒：广播来自站内旧线路，操作者一定还在楼里');
  const power = evidence(blocks, '林澈接通备用电源，所有站台灯同时亮起');
  const target = evidence(blocks, '真正目标是箱内那块记录事故真相的存储芯片');
  return Object.freeze({
    schemaVersion: 'novel-extraction.v1',
    characters: [
      { factId: 'character-lin-che', name: '林澈', description: '修复师，携带证物箱进入旧车站。', evidence: [linChe] },
      { factId: 'character-xia-xian', name: '夏弦', description: '调查员，在车站内协助林澈。', evidence: [xiaXian] },
    ],
    scenes: [{
      factId: 'scene-old-station', location: '海城旧车站', time: '暴雨夜',
      description: '旧车站断电，应急灯亮起。', evidence: [station],
    }],
    props: [{
      factId: 'prop-evidence-case', name: '银色证物箱',
      description: '林澈带入车站的证物箱。', evidence: [caseEvidence],
    }],
    relationships: [{
      factId: 'relationship-investigation-partners',
      fromCharacterFactId: 'character-lin-che',
      toCharacterFactId: 'character-xia-xian',
      relationship: '两人在车站内协同行动并调查广播来源。',
      evidence: [partnership],
    }],
    events: [{
      factId: 'event-restore-power', summary: '林澈恢复备用电源并照亮站台。',
      characterFactIds: ['character-lin-che'], sceneFactId: 'scene-old-station',
      propFactIds: [], evidence: [power],
    }],
    dialogue: [{
      factId: 'dialogue-real-target', speakerCharacterFactId: null,
      content: '真正目标是记录事故真相的存储芯片。', evidence: [target],
    }],
  });
}

function createRainAdaptationOutput() {
  return Object.freeze({
    schemaVersion: 'episode-adaptation.v1',
    durationSummary: Object.freeze({ ...DURATION_BUDGET, totalSeconds: 60 }),
    beats: Object.freeze([
      Object.freeze({
        beatId: 'beat-power-restored', kind: 'hook', summary: '林澈接通备用电源，车站重新亮起。',
        classification: 'fact', inferenceRationale: null, estimatedDurationSeconds: 8,
        factRefs: ['event-restore-power'], adaptationDecisionRefs: [],
      }),
      Object.freeze({
        beatId: 'beat-broadcast-threat', kind: 'setup', summary: '广播操作者可能仍藏在车站内。',
        classification: 'inference', inferenceRationale: '由旧线路广播与夏弦的判断推断威胁仍在现场。',
        estimatedDurationSeconds: 12,
        factRefs: ['relationship-investigation-partners'], adaptationDecisionRefs: [],
      }),
      Object.freeze({
        beatId: 'beat-chip-chase', kind: 'escalation', summary: '新增追踪者抢夺存储芯片。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 14,
        factRefs: ['dialogue-real-target', 'prop-evidence-case'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      }),
      Object.freeze({
        beatId: 'beat-platform-confrontation', kind: 'climax', summary: '林澈与夏弦在站台阻止追踪者。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 16,
        factRefs: ['character-lin-che', 'character-xia-xian'],
        adaptationDecisionRefs: ['decision-add-chip-chase'],
      }),
      Object.freeze({
        beatId: 'beat-chip-reveal', kind: 'cliffhanger', summary: '芯片中出现第二段未公开事故记录。',
        classification: 'adaptation', inferenceRationale: null, estimatedDurationSeconds: 10,
        factRefs: ['dialogue-real-target'], adaptationDecisionRefs: ['decision-add-chip-chase'],
      }),
    ]),
    adaptationDecisions: Object.freeze([Object.freeze({
      decisionId: 'decision-add-chip-chase', classification: 'adaptation',
      category: 'invented-event', summary: '新增追踪者抢夺芯片及站台对峙。',
      rationale: '把原文目标信息转成一分钟单集的升级、高潮与悬念。',
      factRefs: ['dialogue-real-target', 'prop-evidence-case', 'character-lin-che', 'character-xia-xian'],
    })]),
  });
}

function createRainScriptOutput() {
  return Object.freeze({
    schemaVersion: 'script-formatting.v1',
    durationSummary: { totalSeconds: 60 },
    scenes: [
      {
        sceneId: 'script-scene-station-hall', ordinal: 1,
        heading: { interiorExterior: 'UNKNOWN', location: '海城旧车站', time: '暴雨夜' },
        purpose: '恢复照明并确认芯片成为争夺目标。', sceneFactRef: 'scene-old-station',
        characterFactRefs: ['character-lin-che', 'character-xia-xian'],
        propFactRefs: ['prop-evidence-case'],
        beatRefs: ['beat-power-restored', 'beat-broadcast-threat', 'beat-chip-chase'],
        adaptationDecisionRefs: ['decision-add-chip-chase'], estimatedDurationSeconds: 34,
        entries: [
          {
            entryId: 'entry-power-action', type: 'action',
            text: '林澈接通备用电源，站台灯依次亮起。',
            characterFactRefs: ['character-lin-che'], propFactRefs: [],
            beatRefs: ['beat-power-restored'], adaptationDecisionRefs: [], durationSeconds: 8,
          },
          {
            entryId: 'entry-broadcast-action', type: 'action',
            text: '夏弦确认广播仍来自站内旧线路，两人警惕地望向楼梯。',
            characterFactRefs: ['character-lin-che', 'character-xia-xian'], propFactRefs: [],
            beatRefs: ['beat-broadcast-threat'], adaptationDecisionRefs: [], durationSeconds: 12,
          },
          {
            entryId: 'entry-chip-warning', type: 'dialogue', speakerCharacterFactId: null,
            dialogueFactRef: 'dialogue-real-target',
            text: '真正目标是记录事故真相的存储芯片。', emotion: '紧迫',
            speechRateWordsPerMinute: 120, narrativePurpose: 'escalation',
            beatRefs: ['beat-chip-chase'], adaptationDecisionRefs: ['decision-add-chip-chase'],
            durationSeconds: 14,
          },
        ],
      },
      {
        sceneId: 'script-scene-station-platform', ordinal: 2,
        heading: { interiorExterior: 'UNKNOWN', location: '海城旧车站', time: '暴雨夜' },
        purpose: '完成站台对峙并揭开第二段事故记录。', sceneFactRef: 'scene-old-station',
        characterFactRefs: ['character-lin-che', 'character-xia-xian'],
        propFactRefs: ['prop-evidence-case'],
        beatRefs: ['beat-platform-confrontation', 'beat-chip-reveal'],
        adaptationDecisionRefs: ['decision-add-chip-chase'], estimatedDurationSeconds: 26,
        entries: [
          {
            entryId: 'entry-platform-confrontation', type: 'action',
            text: '林澈护住证物箱，夏弦在站台拦住追踪者。',
            characterFactRefs: ['character-lin-che', 'character-xia-xian'],
            propFactRefs: ['prop-evidence-case'], beatRefs: ['beat-platform-confrontation'],
            adaptationDecisionRefs: ['decision-add-chip-chase'], durationSeconds: 16,
          },
          {
            entryId: 'entry-chip-reveal', type: 'action',
            text: '芯片亮起，屏幕显示第二段未公开的事故记录。',
            characterFactRefs: ['character-lin-che'], propFactRefs: ['prop-evidence-case'],
            beatRefs: ['beat-chip-reveal'], adaptationDecisionRefs: ['decision-add-chip-chase'],
            durationSeconds: 10,
          },
        ],
      },
    ],
  });
}

function createRainShotOutput() {
  const shots = [
    {
      shotId: 'shot-power-action', sceneId: 'script-scene-station-hall',
      entryRefs: ['entry-power-action'], durationSeconds: 8, shotSize: 'MS',
      cameraAngle: 'eye_level', cameraMovement: 'dolly',
      composition: '林澈与备用电源位于画面前后景。', action: '跟随林澈接通备用电源。',
      characterFactRefs: ['character-lin-che'], propFactRefs: [], dialogueEntryRefs: [],
    },
    {
      shotId: 'shot-broadcast-action', sceneId: 'script-scene-station-hall',
      entryRefs: ['entry-broadcast-action'], durationSeconds: 12, shotSize: 'MS',
      cameraAngle: 'eye_level', cameraMovement: 'pan',
      composition: '林澈与夏弦同框，楼梯位于画面深处。', action: '两人循广播声望向楼梯。',
      characterFactRefs: ['character-lin-che', 'character-xia-xian'],
      propFactRefs: [], dialogueEntryRefs: [],
    },
    {
      shotId: 'shot-chip-warning', sceneId: 'script-scene-station-hall',
      entryRefs: ['entry-chip-warning'], durationSeconds: 14, shotSize: 'CU',
      cameraAngle: 'eye_level', cameraMovement: 'static',
      composition: '广播喇叭与证物箱形成前后景关联。', action: '广播揭示争夺目标。',
      characterFactRefs: [], propFactRefs: [], dialogueEntryRefs: ['entry-chip-warning'],
    },
    {
      shotId: 'shot-platform-confrontation', sceneId: 'script-scene-station-platform',
      entryRefs: ['entry-platform-confrontation'], durationSeconds: 16, shotSize: 'LS',
      cameraAngle: 'low', cameraMovement: 'truck',
      composition: '站台纵深分隔两人和追踪者。', action: '林澈护箱，夏弦拦截追踪者。',
      characterFactRefs: ['character-lin-che', 'character-xia-xian'],
      propFactRefs: ['prop-evidence-case'], dialogueEntryRefs: [],
    },
    {
      shotId: 'shot-chip-reveal', sceneId: 'script-scene-station-platform',
      entryRefs: ['entry-chip-reveal'], durationSeconds: 10, shotSize: 'ECU',
      cameraAngle: 'overhead', cameraMovement: 'static',
      composition: '芯片屏幕占据画面中心。', action: '屏幕显示第二段事故记录。',
      characterFactRefs: ['character-lin-che'], propFactRefs: ['prop-evidence-case'],
      dialogueEntryRefs: [],
    },
  ].map((shot, index) => Object.freeze({
    ...shot,
    ordinal: index + 1,
    assetVersionRefs: [],
    continuity: {
      transitionFromPrevious: index === 0 ? 'start' : 'cut',
      screenDirection: 'neutral',
      axisStrategy: index === 0 || index === 3 ? 'establish' : 'maintain',
      notes: '保持人物朝向、站台轴线与证物箱位置连续。',
    },
  }));
  return Object.freeze({
    schemaVersion: 'shot-planning.v1',
    aspectRatio: '16:9',
    durationSummary: { totalSeconds: 60 },
    shots: Object.freeze(shots),
  });
}

module.exports = Object.freeze({
  DURATION_BUDGET,
  STYLE,
  createRainAdaptationOutput,
  createRainExtractionOutput,
  createRainScriptOutput,
  createRainShotOutput,
});
