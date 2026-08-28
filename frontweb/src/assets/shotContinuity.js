const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u
const COLOR = /^#[0-9a-f]{6}$/u
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MESSAGE = 'Shot continuity response is invalid'

function fail() {
  throw new TypeError(MESSAGE)
}

function exactObject(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) fail()
    const output = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      output[key] = descriptor.value
    }
    return output
  } catch (error) {
    if (error instanceof TypeError && error.message === MESSAGE) throw error
    return fail()
  }
}

function denseArray(value, maximum, mapper) {
  let descriptors
  try {
    if (!Array.isArray(value)) fail()
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return fail()
  }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail()
  if (Reflect.ownKeys(descriptors).filter((key) => key !== 'length').length !== length) fail()
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
    return mapper(descriptor.value, index)
  }))
}

function uid(value) {
  if (typeof value !== 'string' || !UID.test(value)) fail()
  return value
}

export function continuityUidPath(value) {
  return uid(value)
}

function hash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail()
  return value
}

function text(value, maximum) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')) fail()
  let length = 0
  for (const _character of value) {
    length += 1
    if (length > maximum) fail()
  }
  if (length < 1) fail()
  return value
}

function colors(value) {
  const entries = denseArray(value, 16, (entry) => {
    if (typeof entry !== 'string' || !COLOR.test(entry)) fail()
    return entry
  })
  if (new Set(entries).size !== entries.length) fail()
  return entries
}

function sceneView(value) {
  const input = exactObject(value, [
    'sceneUid', 'versionUid', 'name', 'visualDescription', 'lighting', 'colorAnchors',
  ])
  return Object.freeze({
    sceneUid: uid(input.sceneUid),
    versionUid: uid(input.versionUid),
    name: text(input.name, 120),
    visualDescription: text(input.visualDescription, 4000),
    lighting: text(input.lighting, 1000),
    colorAnchors: colors(input.colorAnchors),
  })
}

function characterView(value) {
  const input = exactObject(value, [
    'factRef', 'characterUid', 'referencePackageUid', 'identityVersionUid',
    'costumeVersionUid',
  ])
  if (typeof input.factRef !== 'string' || !IDENTIFIER.test(input.factRef)) fail()
  return Object.freeze({
    factRef: input.factRef,
    characterUid: uid(input.characterUid),
    referencePackageUid: uid(input.referencePackageUid),
    identityVersionUid: uid(input.identityVersionUid),
    costumeVersionUid: uid(input.costumeVersionUid),
  })
}

function propView(value) {
  const input = exactObject(value, [
    'factRef', 'propUid', 'versionUid', 'name', 'visualDescription', 'colorAnchors',
  ])
  if (typeof input.factRef !== 'string' || !IDENTIFIER.test(input.factRef)) fail()
  return Object.freeze({
    factRef: input.factRef,
    propUid: uid(input.propUid),
    versionUid: uid(input.versionUid),
    name: text(input.name, 120),
    visualDescription: text(input.visualDescription, 4000),
    colorAnchors: colors(input.colorAnchors),
  })
}

function unique(records, keys) {
  for (const key of keys) {
    if (new Set(records.map((record) => record[key])).size !== records.length) fail()
  }
}

export function shotContinuitySnapshotView(value) {
  const input = exactObject(value, [
    'schemaVersion', 'snapshotUid', 'dramaUid', 'shotResultUid', 'shotResultHash',
    'shotEnvelopeHash', 'shotApprovalRef', 'shotId', 'shotOrdinal', 'scene',
    'characters', 'props', 'createdAtEpochMs',
  ])
  if (input.schemaVersion !== '5.0'
    || typeof input.shotApprovalRef !== 'string'
    || !REVIEW_REF.test(input.shotApprovalRef)
    || typeof input.shotId !== 'string'
    || !IDENTIFIER.test(input.shotId)
    || !Number.isSafeInteger(input.shotOrdinal)
    || input.shotOrdinal < 1
    || input.shotOrdinal > 6
    || !Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0
    || input.createdAtEpochMs > 253402300799999) fail()
  const characters = denseArray(input.characters, 128, characterView)
  const props = denseArray(input.props, 128, propView)
  unique(characters, ['factRef', 'characterUid'])
  unique(props, ['factRef', 'propUid'])
  return Object.freeze({
    schemaVersion: '5.0',
    snapshotUid: uid(input.snapshotUid),
    dramaUid: uid(input.dramaUid),
    shotResultUid: uid(input.shotResultUid),
    shotResultHash: hash(input.shotResultHash),
    shotEnvelopeHash: hash(input.shotEnvelopeHash),
    shotApprovalRef: input.shotApprovalRef,
    shotId: input.shotId,
    shotOrdinal: input.shotOrdinal,
    scene: sceneView(input.scene),
    characters,
    props,
    createdAtEpochMs: input.createdAtEpochMs,
  })
}

export function shotContinuitySnapshotListView(value) {
  const snapshots = denseArray(value, 6, shotContinuitySnapshotView)
  unique(snapshots, ['snapshotUid', 'shotId', 'shotOrdinal'])
  const ordered = [...snapshots].sort((left, right) => left.shotOrdinal - right.shotOrdinal)
  if (ordered.some((item, index) => index > 0 && (
    item.shotOrdinal !== ordered[index - 1].shotOrdinal + 1
    || item.dramaUid !== ordered[0].dramaUid
    || item.shotResultUid !== ordered[0].shotResultUid
    || item.shotResultHash !== ordered[0].shotResultHash
    || item.shotEnvelopeHash !== ordered[0].shotEnvelopeHash
    || item.shotApprovalRef !== ordered[0].shotApprovalRef
  ))) fail()
  return Object.freeze(ordered)
}

function uidList(value) {
  const entries = denseArray(value, 128, uid)
  if (new Set(entries).size !== entries.length) fail()
  return entries
}

function transitionGroup(value, kind) {
  const input = exactObject(value, ['unchanged', 'changed', 'entered', 'exited'])
  const changed = denseArray(input.changed, 128, (entry) => {
    const keys = kind === 'character' ? ['characterUid', 'fields'] : ['propUid', 'fields']
    const change = exactObject(entry, keys)
    const allowed = kind === 'character'
      ? ['identityVersionUid', 'referencePackageUid', 'costumeVersionUid']
      : ['versionUid']
    const fields = denseArray(change.fields, allowed.length, (field) => {
      if (!allowed.includes(field)) fail()
      return field
    })
    if (fields.length < 1 || new Set(fields).size !== fields.length) fail()
    return Object.freeze({
      [kind === 'character' ? 'characterUid' : 'propUid']:
        uid(change[kind === 'character' ? 'characterUid' : 'propUid']),
      fields,
    })
  })
  return Object.freeze({
    unchanged: uidList(input.unchanged),
    changed,
    entered: uidList(input.entered),
    exited: uidList(input.exited),
  })
}

export function shotContinuityComparisonView(value) {
  const input = exactObject(value, [
    'schemaVersion', 'fromSnapshotUid', 'toSnapshotUid', 'adjacent',
    'scene', 'characters', 'props',
  ])
  const scene = exactObject(input.scene, [
    'changed', 'fromSceneUid', 'fromVersionUid', 'toSceneUid', 'toVersionUid',
  ])
  if (input.schemaVersion !== '5.0'
    || input.adjacent !== true
    || typeof scene.changed !== 'boolean') fail()
  return Object.freeze({
    schemaVersion: '5.0',
    fromSnapshotUid: uid(input.fromSnapshotUid),
    toSnapshotUid: uid(input.toSnapshotUid),
    adjacent: true,
    scene: Object.freeze({
      changed: scene.changed,
      fromSceneUid: uid(scene.fromSceneUid),
      fromVersionUid: uid(scene.fromVersionUid),
      toSceneUid: uid(scene.toSceneUid),
      toVersionUid: uid(scene.toVersionUid),
    }),
    characters: transitionGroup(input.characters, 'character'),
    props: transitionGroup(input.props, 'prop'),
  })
}

function transitionChanged(group) {
  return group.changed.length > 0 || group.entered.length > 0 || group.exited.length > 0
}

function deriveTransition(left, right, key, versionFields) {
  const leftByUid = new Map(left.map((record) => [record[key], record]))
  const rightByUid = new Map(right.map((record) => [record[key], record]))
  const unchanged = []
  const changed = []
  const entered = []
  const exited = []
  for (const [recordUid, before] of leftByUid) {
    const after = rightByUid.get(recordUid)
    if (!after) {
      exited.push(recordUid)
      continue
    }
    const fields = versionFields.filter((field) => before[field] !== after[field])
    if (fields.length === 0) unchanged.push(recordUid)
    else changed.push({ [key]: recordUid, fields })
  }
  for (const recordUid of rightByUid.keys()) {
    if (!leftByUid.has(recordUid)) entered.push(recordUid)
  }
  return { unchanged, changed, entered, exited }
}

function expectedComparison(left, right) {
  return {
    schemaVersion: '5.0',
    fromSnapshotUid: left.snapshotUid,
    toSnapshotUid: right.snapshotUid,
    adjacent: true,
    scene: {
      changed: left.scene.sceneUid !== right.scene.sceneUid
        || left.scene.versionUid !== right.scene.versionUid,
      fromSceneUid: left.scene.sceneUid,
      fromVersionUid: left.scene.versionUid,
      toSceneUid: right.scene.sceneUid,
      toVersionUid: right.scene.versionUid,
    },
    characters: deriveTransition(left.characters, right.characters, 'characterUid', [
      'identityVersionUid', 'referencePackageUid', 'costumeVersionUid',
    ]),
    props: deriveTransition(left.props, right.props, 'propUid', ['versionUid']),
  }
}

export function continuityReuseSummary(snapshotValues, comparisonValues) {
  const snapshots = shotContinuitySnapshotListView(snapshotValues)
  const comparisons = denseArray(comparisonValues, 5, shotContinuityComparisonView)
  if (comparisons.length !== Math.max(0, snapshots.length - 1)) fail()
  const comparisonViews = comparisons.map((item, index) => {
    if (item.fromSnapshotUid !== snapshots[index].snapshotUid
      || item.toSnapshotUid !== snapshots[index + 1].snapshotUid
      || JSON.stringify(item) !== JSON.stringify(expectedComparison(
        snapshots[index],
        snapshots[index + 1],
      ))) fail()
    const changedLabels = []
    if (item.scene.changed) changedLabels.push('场景版本')
    if (transitionChanged(item.characters)) changedLabels.push('角色版本')
    if (transitionChanged(item.props)) changedLabels.push('道具版本')
    return Object.freeze({
      ...item,
      hasConflict: changedLabels.length > 0,
      changedLabels: Object.freeze(changedLabels),
    })
  })

  const stableCharacters = snapshots.length < 2 ? [] : snapshots[0].characters
    .filter((character) => snapshots.every((shot) => shot.characters.some((candidate) => (
      candidate.characterUid === character.characterUid
      && candidate.identityVersionUid === character.identityVersionUid
      && candidate.referencePackageUid === character.referencePackageUid
      && candidate.costumeVersionUid === character.costumeVersionUid
    ))))
    .map((character) => Object.freeze({
      characterUid: character.characterUid,
      identityVersionUid: character.identityVersionUid,
      referencePackageUid: character.referencePackageUid,
      costumeVersionUid: character.costumeVersionUid,
      shotCount: snapshots.length,
    }))

  return Object.freeze({
    snapshots,
    comparisons: Object.freeze(comparisonViews),
    stableCharacters: Object.freeze(stableCharacters),
    conflictCount: comparisonViews.filter((item) => item.hasConflict).length,
  })
}
