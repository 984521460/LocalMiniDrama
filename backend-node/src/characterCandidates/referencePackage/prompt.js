'use strict';

const { createHash } = require('node:crypto');

const LABELS = Object.freeze({
  front_half_body: '正面半身像',
  three_quarter_face: '脸部四分之三侧视图',
  left_profile: '左侧面视图',
  right_profile: '右侧面视图',
  front_full_body: '正面全身像',
  expression_neutral: '中性表情',
  expression_joy: '喜悦表情',
  expression_anger: '愤怒表情',
  expression_sadness: '悲伤表情',
  expression_fear: '恐惧表情',
});

function createCharacterReferencePackagePrompt(source, candidate, kind) {
  const label = LABELS[kind];
  if (!label) throw new TypeError('Character reference package prompt is invalid');
  const visual = source.characterAppearance
    || source.characterFactDescription
    || source.characterDescription
    || source.characterName;
  const prompt = [
    `为角色“${source.characterName}”生成锁定身份参考图：${label}。`,
    `角色视觉事实：${visual}`,
    `锁定候选内容摘要：${candidate.contentSha256}`,
    '必须保持同一人物身份、五官、发型、体型与默认服装一致。',
    '纯色中性背景，单人，无文字、无水印、无拼图边框。',
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) {
    throw new TypeError('Character reference package prompt is invalid');
  }
  return Object.freeze({
    prompt,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
  });
}

module.exports = Object.freeze({ createCharacterReferencePackagePrompt });
