'use strict';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function model(nodeType, inputName, fileName, sha256, bytes, digestStatus = 'verified') {
  return { nodeType, inputName, fileName, sha256, bytes, digestStatus };
}

const H3_PROFILE = deepFreeze({
  schemaVersion: 'h3-profile.v1',
  uid: '70d4f190-d54d-4d27-9a45-c97807ea1b9d',
  profileId: 'minimax-h3-local-four-step-768p',
  revision: 2,
  engine: 'comfyui',
  modelFamily: 'minimax-h3',
  sourceRevision: '4cc1d817b6184899b41293954329f576cb5ae86b',
  fps: 24,
  frameGrid: { offset: 5, stride: 17, minimum: 5 },
  canvas: {
    multipleOf: 32,
    maximumLongEdge: 1344,
    maximumShortEdge: 768,
    maximumPixels: 1_032_192,
  },
  sampler: {
    steps: 4,
    samplerName: 'res_multistep',
    scheduler: 'simple',
    denoise: 1,
    loraStrength: 1,
  },
  models: {
    diffusion: model(
      'UNETLoader',
      'unet_name',
      'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a',
      20_970_379_616,
    ),
    textEncoder: model(
      'CLIPLoader',
      'clip_name',
      'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6',
      15_687_142_551,
    ),
    videoVae: model(
      'VAELoader',
      'vae_name',
      'minimax_h3_video_vae_fp16.safetensors',
      '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522',
      5_207_808_496,
    ),
    audioVae: model(
      'VAELoader',
      'vae_name',
      'minimax_h3_audio_vae_fp32.safetensors',
      '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48',
      605_254_808,
    ),
    turboLora: model(
      'LoraLoaderModelOnly',
      'lora_name',
      'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
      'c396a9a06f58399e9df9754b18299818d84a2ddd371724ba48fe4a41221437dc',
      1_956_192_992,
    ),
  },
  modes: {
    t2v: {
      referenceImageRoles: [],
      minimumReferenceImages: 0,
      maximumReferenceImages: 0,
      nativeAudioOutput: true,
      realValidation: 'validated-rtx4090',
    },
    'fl2va-first': {
      referenceImageRoles: ['first'],
      minimumReferenceImages: 1,
      maximumReferenceImages: 1,
      nativeAudioOutput: true,
      realValidation: 'validated-rtx4090',
    },
    'fl2va-first-last': {
      referenceImageRoles: ['first', 'last'],
      minimumReferenceImages: 2,
      maximumReferenceImages: 2,
      nativeAudioOutput: true,
      realValidation: 'validated-rtx4090',
    },
    ref2va: {
      referenceImageRoles: ['reference'],
      minimumReferenceImages: 1,
      maximumReferenceImages: 4,
      nativeAudioOutput: true,
      realValidation: 'validated-rtx4090',
    },
  },
});

module.exports = Object.freeze({ H3_PROFILE });
