import {
  createUid,
  type Uid,
} from '@local-mini-drama/domain'

const projectUid = createUid<'project'>()
const sceneUid = createUid<'scene'>()

function acceptsProjectUid(_value: Uid<'project'>): void {}

acceptsProjectUid(projectUid)

// @ts-expect-error A different entity brand must not cross the contract boundary.
acceptsProjectUid(sceneUid)

// @ts-expect-error Unvalidated strings must not be accepted as branded UIDs.
acceptsProjectUid('6ba7b810-9dad-41d1-80b4-00c04fd430c8')
