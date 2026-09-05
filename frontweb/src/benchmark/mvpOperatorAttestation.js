const {
  create: CREATE,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object
const { isArray: IS_ARRAY } = Array
const { apply: REFLECT_APPLY, ownKeys: OWN_KEYS } = Reflect

export const MVP_BENCHMARK_OPERATOR_ATTESTATION_SEED_SCHEMA_VERSION =
  'mvp-benchmark-operator-attestation-seed.v1'
export const MVP_BENCHMARK_COMMERCIAL_ELIGIBILITY_BASES = FREEZE([
  'annual-revenue-not-over-usd-20000000',
  'written-minimax-authorization',
])
const KEYS = FREEZE([
  'schemaVersion',
  'territoryEligibilityConfirmed',
  'commercialEligibilityBasis',
  'commercialUiAttributionAccepted',
  'acceptableUseAndSafeguardsAccepted',
  'downstreamUseRestrictionsAccepted',
  'publicAiContentDisclosureAccepted',
  'benchmarkInputRightsConfirmed',
])
const ERROR_MESSAGE = 'MVP benchmark operator attestation is invalid'

function invalid() {
  throw new TypeError(ERROR_MESSAGE)
}

function exactObject(value) {
  if (!value || typeof value !== 'object' || IS_ARRAY(value)) invalid()
  let prototype
  let descriptors
  try {
    prototype = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [value])
    descriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value])
  } catch {
    invalid()
  }
  const actualKeys = REFLECT_APPLY(OWN_KEYS, Reflect, [descriptors])
  if ((prototype !== Object.prototype && prototype !== null)
    || actualKeys.length !== KEYS.length) invalid()
  const output = REFLECT_APPLY(CREATE, Object, [null])
  for (let index = 0; index < KEYS.length; index += 1) {
    const key = KEYS[index]
    if (!REFLECT_APPLY(HAS_OWN, Object, [descriptors, key])) invalid()
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable
      || !REFLECT_APPLY(HAS_OWN, Object, [descriptor, 'value'])) invalid()
    output[key] = descriptor.value
  }
  return output
}

function basis(value) {
  for (let index = 0; index < MVP_BENCHMARK_COMMERCIAL_ELIGIBILITY_BASES.length; index += 1) {
    if (value === MVP_BENCHMARK_COMMERCIAL_ELIGIBILITY_BASES[index]) return value
  }
  return invalid()
}

function confirmed(value) {
  if (value !== true) invalid()
  return true
}

export function mvpBenchmarkOperatorAttestationSeed(value) {
  const input = exactObject(value)
  if (input.schemaVersion !== MVP_BENCHMARK_OPERATOR_ATTESTATION_SEED_SCHEMA_VERSION) invalid()
  return FREEZE({
    schemaVersion: MVP_BENCHMARK_OPERATOR_ATTESTATION_SEED_SCHEMA_VERSION,
    territoryEligibilityConfirmed: confirmed(input.territoryEligibilityConfirmed),
    commercialEligibilityBasis: basis(input.commercialEligibilityBasis),
    commercialUiAttributionAccepted: confirmed(input.commercialUiAttributionAccepted),
    acceptableUseAndSafeguardsAccepted: confirmed(input.acceptableUseAndSafeguardsAccepted),
    downstreamUseRestrictionsAccepted: confirmed(input.downstreamUseRestrictionsAccepted),
    publicAiContentDisclosureAccepted: confirmed(input.publicAiContentDisclosureAccepted),
    benchmarkInputRightsConfirmed: confirmed(input.benchmarkInputRightsConfirmed),
  })
}
