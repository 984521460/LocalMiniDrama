const { normalizeApprovedAdaptation } = require('./approvedAdaptation');
const { normalizeApprovedExtraction } = require('./approvedExtraction');
const { narrativeTaskError } = require('./errors');
const { sha256Canonical } = require('./jsonSnapshot');

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function referenceInvalid() {
  throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
}

function createCatalog(extraction) {
  return {
    characters: new Map(extraction.characters.map((fact) => [fact.factId, fact])),
    scenes: new Map(extraction.scenes.map((fact) => [fact.factId, fact])),
    props: new Map(extraction.props.map((fact) => [fact.factId, fact])),
    dialogue: new Map(extraction.dialogue.map((fact) => [fact.factId, fact])),
  };
}

function normalizeScriptDomain(domain) {
  const extraction = normalizeApprovedExtraction(
    domain.approvedExtraction,
    domain.extractionApproval,
  );
  const adaptation = normalizeApprovedAdaptation(
    domain.adaptationResult,
    domain.adaptationApproval,
  );
  if (adaptation.result.upstreamResultHash !== extraction.approval.resultHash
    || adaptation.result.approvalRef !== extraction.approval.reviewRef
    || adaptation.result.inputHash !== sha256Canonical({
      approval: extraction.approval,
      approvedExtraction: extraction.extraction,
      durationBudget: adaptation.result.durationBudget,
      style: adaptation.result.style,
    })
    || adaptation.factIds.some((factId) => !extraction.factIds.includes(factId))) invalidInput();
  return {
    adaptation,
    catalog: createCatalog(extraction.extraction),
    extraction,
  };
}

function createScriptInputHash(domain) {
  return sha256Canonical({
    adaptationApproval: domain.adaptation.approval,
    adaptationResult: domain.adaptation.result,
    approvedExtraction: domain.extraction.extraction,
    extractionApproval: domain.extraction.approval,
  });
}

function assertTypedRefs(refs, catalog, sceneRefs = null) {
  if (refs.some((ref) => !catalog.has(ref)
    || (sceneRefs && !sceneRefs.has(ref)))) referenceInvalid();
}

function assertScriptSemantics(domain, output) {
  const beatIds = new Set(domain.adaptation.beatIds);
  const approvedBeatIds = domain.adaptation.output.beats.map((beat) => beat.beatId);
  const mappedBeatIds = [];
  const beatsById = new Map(
    domain.adaptation.output.beats.map((beat) => [beat.beatId, beat]),
  );
  const decisionIds = new Set(domain.adaptation.decisionIds);
  const coveredBeatIds = new Set();
  const usedDecisionIds = new Set();
  const sceneIds = new Set();
  const entryIds = new Set();
  let totalSeconds = 0;

  for (let sceneIndex = 0; sceneIndex < output.scenes.length; sceneIndex += 1) {
    const scene = output.scenes[sceneIndex];
    if (scene.ordinal !== sceneIndex + 1 || sceneIds.has(scene.sceneId)) referenceInvalid();
    sceneIds.add(scene.sceneId);
    const sceneCharacters = new Set(scene.characterFactRefs);
    const sceneProps = new Set(scene.propFactRefs);
    assertTypedRefs(scene.characterFactRefs, domain.catalog.characters);
    assertTypedRefs(scene.propFactRefs, domain.catalog.props);
    if (scene.beatRefs.some((beatId) => !beatIds.has(beatId))
      || scene.adaptationDecisionRefs.some((decisionId) => !decisionIds.has(decisionId))) {
      referenceInvalid();
    }
    const requiredSceneDecisions = new Set(scene.beatRefs.flatMap(
      (beatId) => beatsById.get(beatId).adaptationDecisionRefs,
    ));
    if ([...requiredSceneDecisions].some(
      (decisionId) => !scene.adaptationDecisionRefs.includes(decisionId),
    )) referenceInvalid();
    for (const beatId of scene.beatRefs) {
      coveredBeatIds.add(beatId);
      mappedBeatIds.push(beatId);
    }
    for (const decisionId of scene.adaptationDecisionRefs) usedDecisionIds.add(decisionId);

    if (scene.sceneFactRef !== null) {
      const sourceScene = domain.catalog.scenes.get(scene.sceneFactRef);
      if (!sourceScene) referenceInvalid();
      const headingNeedsDecision = scene.heading.interiorExterior !== 'UNKNOWN'
        || scene.heading.location !== sourceScene.location
        || scene.heading.time !== sourceScene.time;
      if (headingNeedsDecision && scene.adaptationDecisionRefs.length === 0) referenceInvalid();
    }

    const sceneEntryBeatIds = new Set();
    let sceneSeconds = 0;
    for (const entry of scene.entries) {
      if (entryIds.has(entry.entryId)
        || entry.beatRefs.some((beatId) => !beatIds.has(beatId)
          || !scene.beatRefs.includes(beatId))
        || entry.adaptationDecisionRefs.some((decisionId) => !decisionIds.has(decisionId)
          || !scene.adaptationDecisionRefs.includes(decisionId))) referenceInvalid();
      entryIds.add(entry.entryId);
      for (const beatId of entry.beatRefs) sceneEntryBeatIds.add(beatId);
      for (const decisionId of entry.adaptationDecisionRefs) usedDecisionIds.add(decisionId);

      if (entry.type === 'action') {
        assertTypedRefs(entry.characterFactRefs, domain.catalog.characters, sceneCharacters);
        assertTypedRefs(entry.propFactRefs, domain.catalog.props, sceneProps);
        const requiredEntryDecisions = new Set(entry.beatRefs.flatMap(
          (beatId) => beatsById.get(beatId).adaptationDecisionRefs,
        ));
        if ([...requiredEntryDecisions].some(
          (decisionId) => !entry.adaptationDecisionRefs.includes(decisionId),
        )) referenceInvalid();
      } else {
        if (entry.speakerCharacterFactId !== null
          && (!domain.catalog.characters.has(entry.speakerCharacterFactId)
            || !sceneCharacters.has(entry.speakerCharacterFactId))) referenceInvalid();
        if (entry.dialogueFactRef !== null) {
          const sourceLine = domain.catalog.dialogue.get(entry.dialogueFactRef);
          if (!sourceLine) referenceInvalid();
          if ((entry.text !== sourceLine.content
            || entry.speakerCharacterFactId !== sourceLine.speakerCharacterFactId)
            && entry.adaptationDecisionRefs.length === 0) referenceInvalid();
        }
      }
      sceneSeconds += entry.durationSeconds;
    }
    if (scene.beatRefs.some((beatId) => !sceneEntryBeatIds.has(beatId))
      || sceneSeconds !== scene.estimatedDurationSeconds) {
      throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
    }
    totalSeconds += sceneSeconds;
  }

  if (mappedBeatIds.length !== approvedBeatIds.length
    || mappedBeatIds.some((beatId, index) => beatId !== approvedBeatIds[index])
    || [...beatIds].some((beatId) => !coveredBeatIds.has(beatId))
    || [...decisionIds].some((decisionId) => !usedDecisionIds.has(decisionId))) referenceInvalid();
  if (!Number.isSafeInteger(totalSeconds)
    || totalSeconds !== output.durationSummary.totalSeconds
    || totalSeconds !== domain.adaptation.output.durationSummary.totalSeconds) {
    throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
  }
}

module.exports = {
  assertScriptSemantics,
  createScriptInputHash,
  normalizeScriptDomain,
};
