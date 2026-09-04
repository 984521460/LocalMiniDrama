'use strict';

const { sha256Canonical } = require('../h3/contract');
const { RTX_4090_GPU_CLASS } = require('../h3/gpuClasses');

const MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256 =
  '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const APPROVED_LIVE_ENVIRONMENT = deepFreeze({
  gpu: {
    gpuClass: RTX_4090_GPU_CLASS,
    name: 'NVIDIA GeForce RTX 4090',
    vramMiB: 24564,
    driverVersion: '595.84',
  },
  comfyUI: {
    version: '0.33.0',
    revision: '0696f61d953d09878988ebc4ca46e263f73ff65f',
    listenScope: 'loopback',
  },
  runtime: {
    pythonVersion: '3.12.12',
    pytorchVersion: '2.11.0+cu130',
    ffmpegVersion: '8.1.2',
  },
  models: [
    {
      role: 'fl2va-diffusion',
      fileName: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      sha256: 'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a',
      bytes: 20_970_379_616,
    },
    {
      role: 'ref2va-diffusion',
      fileName: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
      sha256: '9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779',
      bytes: 20_970_379_616,
    },
    {
      role: 'text-encoder',
      fileName: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      sha256: '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6',
      bytes: 15_687_142_551,
    },
    {
      role: 'video-vae',
      fileName: 'minimax_h3_video_vae_fp16.safetensors',
      sha256: '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522',
      bytes: 5_207_808_496,
    },
    {
      role: 'audio-vae',
      fileName: 'minimax_h3_audio_vae_fp32.safetensors',
      sha256: '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48',
      bytes: 605_254_808,
    },
    {
      role: 'fl2va-turbo-lora',
      fileName: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
      sha256: 'c396a9a06f58399e9df9754b18299818d84a2ddd371724ba48fe4a41221437dc',
      bytes: 1_956_192_992,
    },
    {
      role: 'ref2va-turbo-lora',
      fileName: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
      sha256: '5b9ab5ade15d0775676d01a907268a69a1468dc6033b3b0d3ded5502f3ebb84c',
      bytes: 1_956_193_000,
    },
  ],
});

if (sha256Canonical(APPROVED_LIVE_ENVIRONMENT)
  !== MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256) {
  throw new TypeError('MVP benchmark approved environment is invalid');
}

module.exports = Object.freeze({
  APPROVED_LIVE_ENVIRONMENT,
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
});
