'use strict';

const { H3_PROFILE } = require('../../h3/profile');
const { H3_REF2VA_MODEL_FILES } = require('../../h3/workflowSources');

const COMMON_MODEL_FILES = Object.freeze({
  diffusionModel: H3_PROFILE.models.diffusion.fileName,
  textEncoder: H3_PROFILE.models.textEncoder.fileName,
  videoVae: H3_PROFILE.models.videoVae.fileName,
  audioVae: H3_PROFILE.models.audioVae.fileName,
  turboLora4Step: H3_PROFILE.models.turboLora.fileName,
});

function commonGraph({ diffusionModel, turboLora4Step }) {
  return {
    92: {
      class_type: 'SaveVideo',
      inputs: {
        video: ['130', 0],
        filename_prefix: 'video/H3_candidate',
        format: 'auto',
        codec: 'auto',
      },
      _meta: { title: 'APP_H3_OUTPUT_VIDEO' },
    },
    119: { class_type: 'VAELoader', inputs: { vae_name: COMMON_MODEL_FILES.videoVae } },
    120: { class_type: 'VAELoader', inputs: { vae_name: COMMON_MODEL_FILES.audioVae } },
    121: { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
    122: { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
    123: { class_type: 'KSamplerSelect', inputs: { sampler_name: H3_PROFILE.sampler.samplerName } },
    124: {
      class_type: 'BasicScheduler',
      inputs: {
        model: ['134', 0],
        scheduler: H3_PROFILE.sampler.scheduler,
        steps: H3_PROFILE.sampler.steps,
        denoise: H3_PROFILE.sampler.denoise,
      },
    },
    125: {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['129', 0],
        guider: ['126', 0],
        sampler: ['123', 0],
        sigmas: ['124', 0],
        latent_image: ['131', 1],
      },
    },
    126: {
      class_type: 'BasicGuider',
      inputs: { model: ['134', 0], conditioning: ['131', 0] },
    },
    127: { class_type: 'UNETLoader', inputs: { unet_name: diffusionModel, weight_dtype: 'default' } },
    128: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: COMMON_MODEL_FILES.textEncoder, type: 'minimax', device: 'default' },
    },
    129: {
      class_type: 'RandomNoise',
      inputs: { noise_seed: 0 },
      _meta: { title: 'APP_H3_SEED' },
    },
    130: {
      class_type: 'CreateVideo',
      inputs: { images: ['122', 0], audio: ['121', 0], fps: H3_PROFILE.fps, bit_depth: 8 },
    },
    134: {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['127', 0],
        lora_name: turboLora4Step,
        strength_model: H3_PROFILE.sampler.loraStrength,
      },
    },
  };
}

function addImageLoaders(graph, referenceImageCount) {
  for (let index = 0; index < referenceImageCount; index += 1) {
    const nodeId = 201 + index;
    graph[nodeId] = {
      class_type: 'LoadImage',
      inputs: { image: `h3-input/reference-${index + 1}.png` },
      _meta: { title: `APP_H3_REFERENCE_IMAGE_${index + 1}` },
    };
  }
}

function buildH3FirstLastFrameCandidateGraph(mode) {
  const referenceImageCount = mode === 'fl2va-first' ? 1 : 2;
  const graph = commonGraph({
    diffusionModel: COMMON_MODEL_FILES.diffusionModel,
    turboLora4Step: COMMON_MODEL_FILES.turboLora4Step,
  });
  addImageLoaders(graph, referenceImageCount);
  graph[131] = {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['128', 0],
      vae: ['119', 0],
      first_frame: ['201', 0],
      ...(mode === 'fl2va-first-last' ? { last_frame: ['202', 0] } : {}),
      prompt: 'A quiet cinematic scene unfolds with clear motion.',
      width: 608,
      height: 352,
      length: 39,
    },
    _meta: { title: 'APP_H3_GENERATION' },
  };
  return graph;
}

function buildH3ReferenceToVideoCandidateGraph({ referenceImageCount, referenceAudio }) {
  const graph = commonGraph({
    diffusionModel: H3_REF2VA_MODEL_FILES.diffusionModel,
    turboLora4Step: H3_REF2VA_MODEL_FILES.turboLora4Step,
  });
  addImageLoaders(graph, referenceImageCount);
  if (referenceAudio) {
    graph[301] = {
      class_type: 'LoadAudio',
      inputs: { audio: 'h3-input/reference-audio.wav' },
      _meta: { title: 'APP_H3_REFERENCE_AUDIO' },
    };
  }
  const referenceInputs = {};
  for (let index = 0; index < referenceImageCount; index += 1) {
    referenceInputs[`ref_images.ref_image_${index}`] = [String(201 + index), 0];
  }
  graph[131] = {
    class_type: 'MiniMaxH3ReferenceToVideo',
    inputs: {
      clip: ['128', 0],
      vae: ['119', 0],
      audio_vae: ['120', 0],
      ...referenceInputs,
      ...(referenceAudio ? { 'ref_audios.ref_audio_0': ['301', 0] } : {}),
      prompt: 'A quiet cinematic scene unfolds with clear motion.',
      width: 608,
      height: 352,
      length: 39,
      ref_image_size: 'match',
    },
    _meta: { title: 'APP_H3_GENERATION' },
  };
  return graph;
}

module.exports = Object.freeze({
  buildH3FirstLastFrameCandidateGraph,
  buildH3ReferenceToVideoCandidateGraph,
});
