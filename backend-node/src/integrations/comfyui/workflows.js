'use strict';

const { h3FramesForDuration } = require('../../h3/generationSpec');
const { H3_PROFILE } = require('../../h3/profile');

const H3_MODEL_FILES = Object.freeze({
  diffusionModel: H3_PROFILE.models.diffusion.fileName,
  textEncoder: H3_PROFILE.models.textEncoder.fileName,
  videoVae: H3_PROFILE.models.videoVae.fileName,
  audioVae: H3_PROFILE.models.audioVae.fileName,
  turboLora4Step: H3_PROFILE.models.turboLora.fileName,
});

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function requireDimension(value, label, { multipleOf32 = false } = {}) {
  const dimension = requirePositiveInteger(value, label);
  if (multipleOf32 && dimension % 32 !== 0) throw new TypeError(`${label} must be a multiple of 32`);
  return dimension;
}

function requireFilenamePrefix(value) {
  const prefix = String(value || '').trim();
  if (
    !prefix
    || prefix.length > 160
    || prefix.startsWith('/')
    || /^[a-z]:/i.test(prefix)
    || prefix.includes('\\')
    || prefix.split('/').includes('..')
  ) {
    throw new TypeError('filenamePrefix must be a safe relative prefix');
  }
  return prefix;
}

function buildMinimalImagePrompt({
  width = 64,
  height = 64,
  batchSize = 1,
  color = 0,
  filenamePrefix = 'phase1/ComfyUI_smoke',
} = {}) {
  const normalizedColor = Number(color);
  if (!Number.isInteger(normalizedColor) || normalizedColor < 0 || normalizedColor > 0xffffff) {
    throw new TypeError('color must be an integer between 0 and 0xffffff');
  }

  return {
    1: {
      class_type: 'EmptyImage',
      inputs: {
        width: requireDimension(width, 'width'),
        height: requireDimension(height, 'height'),
        batch_size: requirePositiveInteger(batchSize, 'batchSize'),
        color: normalizedColor,
      },
    },
    2: {
      class_type: 'SaveImage',
      inputs: {
        images: ['1', 0],
        filename_prefix: requireFilenamePrefix(filenamePrefix),
      },
    },
  };
}

function buildMinimaxH3TextToVideoPrompt({
  prompt,
  width = 608,
  height = 352,
  durationSeconds = 5,
  seed = 1,
  filenamePrefix = 'video/MiniMax_H3',
} = {}) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) throw new TypeError('prompt must not be empty');
  if (normalizedPrompt.length > 100_000) throw new TypeError('prompt is too long');
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError('seed must be a non-negative safe integer');

  const normalizedWidth = requireDimension(width, 'width', { multipleOf32: true });
  const normalizedHeight = requireDimension(height, 'height', { multipleOf32: true });
  if (
    Math.max(normalizedWidth, normalizedHeight) > H3_PROFILE.canvas.maximumLongEdge
    || Math.min(normalizedWidth, normalizedHeight) > H3_PROFILE.canvas.maximumShortEdge
    || normalizedWidth * normalizedHeight > H3_PROFILE.canvas.maximumPixels
  ) {
    throw new TypeError('H3 canvas must fit within the official 768 x 1344 limit');
  }
  const length = h3FramesForDuration(durationSeconds);

  return {
    119: { class_type: 'VAELoader', inputs: { vae_name: H3_MODEL_FILES.videoVae } },
    120: { class_type: 'VAELoader', inputs: { vae_name: H3_MODEL_FILES.audioVae } },
    121: { class_type: 'VAEDecodeAudio', inputs: { samples: ['125', 0], vae: ['120', 0] } },
    122: { class_type: 'VAEDecode', inputs: { samples: ['125', 0], vae: ['119', 0] } },
    123: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
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
    127: {
      class_type: 'UNETLoader',
      inputs: { unet_name: H3_MODEL_FILES.diffusionModel, weight_dtype: 'default' },
    },
    128: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: H3_MODEL_FILES.textEncoder, type: 'minimax', device: 'default' },
    },
    129: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    130: {
      class_type: 'CreateVideo',
      inputs: { images: ['122', 0], audio: ['121', 0], fps: H3_PROFILE.fps, bit_depth: 8 },
    },
    131: {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['128', 0],
        vae: ['119', 0],
        prompt: normalizedPrompt,
        width: normalizedWidth,
        height: normalizedHeight,
        length,
      },
    },
    134: {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['127', 0],
        lora_name: H3_MODEL_FILES.turboLora4Step,
        strength_model: H3_PROFILE.sampler.loraStrength,
      },
    },
    92: {
      class_type: 'SaveVideo',
      inputs: {
        video: ['130', 0],
        filename_prefix: requireFilenamePrefix(filenamePrefix),
        format: 'auto',
        codec: 'auto',
      },
    },
  };
}

module.exports = {
  H3_MODEL_FILES,
  buildMinimaxH3TextToVideoPrompt,
  buildMinimalImagePrompt,
  h3FramesForDuration,
};
