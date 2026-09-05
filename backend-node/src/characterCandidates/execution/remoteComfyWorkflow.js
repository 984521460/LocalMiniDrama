'use strict';

const OUTPUT_NODE_ID = '7';

function buildRemoteComfyCharacterPrompt(command, profile) {
  return Object.freeze({
    1: Object.freeze({
      class_type: 'CheckpointLoaderSimple',
      inputs: Object.freeze({ ckpt_name: profile.checkpointName }),
    }),
    2: Object.freeze({
      class_type: 'CLIPTextEncode',
      inputs: Object.freeze({ text: command.prompt, clip: Object.freeze(['1', 1]) }),
    }),
    3: Object.freeze({
      class_type: 'CLIPTextEncode',
      inputs: Object.freeze({ text: profile.negativePrompt, clip: Object.freeze(['1', 1]) }),
    }),
    4: Object.freeze({
      class_type: 'EmptyLatentImage',
      inputs: Object.freeze({
        width: command.width,
        height: command.height,
        batch_size: 1,
      }),
    }),
    5: Object.freeze({
      class_type: 'KSampler',
      inputs: Object.freeze({
        seed: command.seed,
        steps: profile.steps,
        cfg: profile.cfg,
        sampler_name: profile.samplerName,
        scheduler: profile.scheduler,
        denoise: 1,
        model: Object.freeze(['1', 0]),
        positive: Object.freeze(['2', 0]),
        negative: Object.freeze(['3', 0]),
        latent_image: Object.freeze(['4', 0]),
      }),
    }),
    6: Object.freeze({
      class_type: 'VAEDecode',
      inputs: Object.freeze({ samples: Object.freeze(['5', 0]), vae: Object.freeze(['1', 2]) }),
    }),
    7: Object.freeze({
      class_type: 'SaveImage',
      inputs: Object.freeze({
        images: Object.freeze(['6', 0]),
        filename_prefix: `character-candidates/${command.operationUid}/${command.ordinal}`,
      }),
    }),
  });
}

module.exports = Object.freeze({ OUTPUT_NODE_ID, buildRemoteComfyCharacterPrompt });
