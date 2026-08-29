'use strict';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const H3_OFFICIAL_WORKFLOW_SOURCES = deepFreeze({
  i2v: {
    repository: 'Comfy-Org/workflow_templates',
    commit: '0b1ef3ec90846bf82eba195ddcc30a1f5b2b6b38',
    templatePath: 'templates/video_minimax_h3_i2v.json',
    templateSha256: '4dc94e9ea308c1d60409e7f55dba5e2788dab4659c2dbb90f1e9481498767540',
    templateBytes: 71_242,
    realValidation: 'validated-rtx4090',
  },
  ref2v: {
    repository: 'Comfy-Org/workflow_templates',
    commit: '0b1ef3ec90846bf82eba195ddcc30a1f5b2b6b38',
    templatePath: 'templates/video_minimax_h3_r2v.json',
    templateSha256: '14b30659a057547e02bdd4bbbdda3f8670aa6d7d81d1d8d99c4f9ad1e2eabc44',
    templateBytes: 45_121,
    realValidation: 'validated-rtx4090',
  },
});

const H3_REF2VA_MODEL_FILES = deepFreeze({
  diffusionModel: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  turboLora4Step: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
});

module.exports = Object.freeze({
  H3_OFFICIAL_WORKFLOW_SOURCES,
  H3_REF2VA_MODEL_FILES,
});
