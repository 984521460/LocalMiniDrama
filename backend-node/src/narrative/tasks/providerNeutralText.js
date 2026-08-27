const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f]|\p{Cf}/u;
const HIERARCHICAL_URI = /[a-z][a-z0-9+.-]{1,31}:\/\//iu;
const OPAQUE_URI = /(?:^|[^a-z0-9+.-])(?:blob|cid|data|file|ftp|git|https?|ipfs|magnet|mailto|news|nntp|s3|sms|ssh|tel|urn|wss?):(?=\S)/iu;
const RELATIVE_PATH = /\.{1,2}[\\/](?=[^\s])/iu;
const HOME_OR_ENV_PATH = /(?:^|[\s"'(])(?:~[\\/]|%[a-z_][a-z0-9_]*%[\\/]|\$env:[a-z_][a-z0-9_]*[\\/]|\$(?:\{[a-z_][a-z0-9_]*\}|[a-z_][a-z0-9_]*)[\\/])/iu;
const WINDOWS_DRIVE_OR_UNC_PATH = /[a-z]\s*:\s*[\\/]\s*(?=\S)|\\\\\s*\S/iu;
const WINDOWS_ROOT_RELATIVE_PATH = /(?:^|[\s"'(])\\(?:[^\s\\/:*?"<>|]+\\)+[^\s\\/:*?"<>|]+/u;
const ABSOLUTE_PATH = /(?:^|[\s"'(])\/(?!\/)[^\s/"']+(?:\/[^\s/"']+)*/u;
const UNIX_ROOT_PATH = /\/(?:home|root|users?|models?|checkpoints?|workflows?|tmp|var|opt|mnt|data)(?:\/|$)/iu;
const PATH_AFTER_INTENT = /(?:load|path|file|model|checkpoint|workflow|载入|加载|路径|文件|模型)\s*["']?(?:[\\/]\s*|~[\\/]|%[a-z_][a-z0-9_]*%[\\/]|\$env:[a-z_][a-z0-9_]*[\\/]|\$(?:\{[a-z_][a-z0-9_]*\}|[a-z_][a-z0-9_]*)[\\/])[^\s"']+/iu;
const MODEL_OR_WORKFLOW_FILE = /\.(?:safetensors|ckpt|pt|pth|onnx|ort|gguf|ggml|tflite|pb|bin|engine|h5|pkl|np[yz]|mlmodel|mlpackage|caffemodel|prototxt|json|ya?ml)(?:$|[^\p{L}\p{N}])/iu;
const FILE_AFTER_INTENT = /(?:load|path|file|model|checkpoint|workflow|载入|加载|路径|文件|模型)\s+["']?[^\s"'\\/]+\.[a-z0-9]{1,16}(?:$|[\s"'])/iu;
const COMMAND_OR_TEMPLATE_SYNTAX = /--\s*[a-z0-9]|[{}\[\]<>`|=]/iu;

const TECHNICAL_NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?';
const PARAMETER_NAME = [
  'c[\\s_-]*f[\\s_-]*g(?:[\\s_-]*scale)?',
  'guidance[\\s_-]*scale',
  'steps',
  'seed',
  'denoise',
  'width',
  'height',
  'frames?',
  'fps',
  'batch[\\s_-]*size',
].join('|');
const EXPLICIT_NUMERIC_PARAMETER = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${PARAMETER_NAME})[\\s:_=-]*[:_=-][\\s:_=-]*(?:${TECHNICAL_NUMBER})(?![\\p{L}\\p{N}])`,
  'iu',
);
const ADJACENT_NUMERIC_PARAMETER = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${PARAMETER_NAME})(?:${TECHNICAL_NUMBER})(?![\\p{L}\\p{N}])`,
  'iu',
);
const UNAMBIGUOUS_NUMERIC_PARAMETER = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:c[\\s_-]*f[\\s_-]*g(?:[\\s_-]*scale)?|guidance[\\s_-]*scale|denoise|frames?|fps|batch[\\s_-]*size)\\s+(?:${TECHNICAL_NUMBER})(?![\\p{L}\\p{N}])`,
  'iu',
);
const AMBIGUOUS_NUMERIC_PARAMETER = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?<name>steps|seed|width|height)\\s+(?<number>${TECHNICAL_NUMBER})(?![\\p{L}\\p{N}])`,
  'giu',
);
const TECHNICAL_PARAMETER_CONTEXT = /\b(?:cfg|denoise|fps|frames?|parameter|parameters|prompt|render|sampler|scheduler|setting|settings|workflow)\b|(?:参数|设置|提示词|工作流|采样器|调度器|渲染)/iu;
const PIXEL_UNIT = /^\s*(?:px|pixels?)\b/iu;
const PHYSICAL_MEASUREMENT_UNIT = /^\s*(?:(?:millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|kilomet(?:er|re)s?|inches?|feet|foot|yards?|miles?|stories|story|storeys|storey|floors?|levels?|paces?|mm|cm|km|ft|m)\b|毫米|厘米|米|公里|英寸|英尺|码|层)/iu;

const TOKEN_SEPARATOR = '[\\s:_=-]+';
const SAMPLER_PREFIX = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])sampler(?:${TOKEN_SEPARATOR}name)?${TOKEN_SEPARATOR}`,
  'iu',
);
const SCHEDULER_PREFIX = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])scheduler${TOKEN_SEPARATOR}`,
  'iu',
);
const EXPLICIT_SAMPLER_DIRECTIVE = /(?:^|[^\p{L}\p{N}])(?:sampler(?:[\s:_=-]+name)?|scheduler)(?:\s*[:=_-]\s*[a-z0-9+]|\s+[a-z0-9+]+(?:[_=+-][a-z0-9+]+)+)/iu;
const TECHNICAL_WORD = /[a-z][a-z0-9+._-]*/giu;
const TERMINAL_SENTENCE_PUNCTUATION = /[.!?。！？]+$/u;
const SAMPLER_RESTRICTED_ACTION = new Set([
  'assign', 'assigns', 'change', 'changes', 'choose', 'chooses', 'enable', 'enables',
  'pick', 'picks', 'select', 'selects', 'set', 'sets', 'switch', 'switches',
  'use', 'uses', 'using',
]);
const SAMPLER_PREFIX_TECHNICAL = new Set([
  'generate', 'generated', 'generating', 'infer', 'inference', 'render', 'rendered', 'rendering',
]);
const SAMPLER_SUFFIX_TECHNICAL = new Set([
  'configuration', 'generate', 'generation', 'image', 'infer', 'inference', 'model',
  'parameter', 'render', 'rendering', 'sampling', 'setting', 'video', 'workflow',
]);
const ALIAS_TOKENS = new RegExp(`^[a-z0-9+]+(?:${TOKEN_SEPARATOR}[a-z0-9+]+){0,4}`, 'iu');
const SAMPLER_ALIASES = new Set([
  'ddim', 'deis', 'dpm2', 'dpm2a', 'dpm2ancestral', 'dpmadaptive', 'dpmfast',
  'dpmpp2m', 'dpmpp2msde', 'dpmpp2msdegpu', 'dpmpp2sancestral', 'dpmpp3msde',
  'dpmppsde', 'dpmppsdegpu', 'euler', 'eulera', 'eulerancestral', 'heun',
  'ipndm', 'lcm', 'lms', 'unipc',
]);
const SCHEDULER_ALIASES = new Set([
  'ddimuniform', 'exponential', 'karras', 'kloptimal', 'linearquadratic',
  'normal', 'sgmuniform', 'simple',
]);
const BARE_SAMPLER_SIGNATURE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])dpm(?:\\+\\+|pp)${TOKEN_SEPARATOR}(?:2m(?:${TOKEN_SEPARATOR}sde)?|sde)(?:${TOKEN_SEPARATOR}karras)?(?=$|[^\\p{L}\\p{N}])`,
  'iu',
);

const PROVIDER_OR_WORKFLOW_TERM = /(?:^|[^\p{L}\p{N}])(?:midjourney|comfy[\s_-]*ui|k[\s_-]*sampler|checkpoint[\s_-]*loader|seedance|workflow|工作流|negative[\s_-]*prompt)(?=$|[^\p{L}\p{N}])/iu;
const TECHNICAL_RESOURCE_CONTEXT = /(?:\b(?:load|loading|use|using|apply|model|prompt|token|weights?|file|path|loader|adapter)\s+(?:(?:the|a|an|this|my)\s+)?(?:lora|embedding|checkpoint)\b|\b(?:lora|embedding|checkpoint)(?:\s*[:=_-]\s*|\s+)(?:model|prompt|token|weights?|file|path|loader|adapter|strength|scale|safetensors|ckpt)\b|\b(?:lora|embedding)\s*[:=_]\s*[\p{L}\p{N}_.+-]+)/iu;
const AMBIGUOUS_PROVIDER_CONTEXT = /(?:\b(?:generate|generated|render|rendered|create|created)\b.{0,24}\b(?:using|with|via)\s+(?:mid[\s_-]+journey|stable[\s_-]+diffusion)\b|\bpowered\s+by\s+(?:mid[\s_-]+journey|stable[\s_-]+diffusion)\b|\bmid[\s_-]+journey\b.{0,24}\b(?:prompt|preset|model|provider|style|generation)\b|\bstable[\s_-]+diffusion\b.{0,24}\b(?:prompt|checkpoint|preset|model|provider|xl|generation|workflow)\b)/iu;
const CHINESE_PROVIDER_TERM = /(?:^|[^\p{L}\p{N}])(?:可灵|即梦)(?:$|[^\p{L}\p{N}])/u;
const ASCII_PROVIDER_NAME = '(?<![a-z0-9])(?:runway|kling|mid[\\s_-]*journey|stable[\\s_-]*diffusion)(?![a-z0-9])';
const ASCII_PROVIDER_GENERATION_ACTION = new RegExp(
  `\\b(?:use|uses|using)\\s+${ASCII_PROVIDER_NAME}\\s+to\\s+(?:create|generate|produce|render)\\b`,
  'iu',
);
const CHINESE_PROVIDER_CONTEXT = new RegExp(
  `(?:(?:可灵(?!活)|即梦)(?:模型|平台|接口|api|提示词|参数|生成|风格|制作|出图)|(?:使用|调用|适配|供应商|通过|由|基于|经由|采用|借助).{0,12}${ASCII_PROVIDER_NAME}.{0,12}(?:模型|平台|接口|api|提示词|参数|制作|生成|出图))`,
  'iu',
);
const RUNWAY_PROVIDER_CONTEXT = /(?:\b(?:use|using|via)\s+(?:the\s+)?runway\b.{0,24}\b(?:ai|prompt|video\s+generation|generator|api|provider|gen(?:eration)?[-\s]?\d+)\b|\brunway(?:\s*[:=_-]\s*|\s+)(?:ai(?:\s+video)?|prompt|video\s+generation|generator|api|provider|gen(?:eration)?[-\s]?\d+)\b|\b(?:generate|generated|render|rendered|create|created)\b.{0,24}\b(?:using|with|via)\s+runway\b|\bpowered\s+by\s+runway\b)/iu;
const KLING_PROVIDER_CONTEXT = /(?:\b(?:use|using|via)\s+kling\b.{0,24}\b(?:ai|prompt|video|generator|model|api|provider|generation)\b|\bkling(?:\s*[:=_-]\s*|\s+)(?:ai\s+video|prompt|video|generator|model|api|provider|generation)\b|\b(?:generate|generated|render|rendered|create|created)\b.{0,24}\b(?:using|with|via)\s+kling\b|\bpowered\s+by\s+kling\b)/iu;

function containsAmbiguousNumericParameter(value) {
  const matches = [...value.matchAll(AMBIGUOUS_NUMERIC_PARAMETER)];
  if (matches.length === 0) return false;
  if (TECHNICAL_PARAMETER_CONTEXT.test(value)) return true;
  for (const match of matches) {
    const name = match.groups.name.toLocaleLowerCase('en-US');
    const suffix = value.slice(match.index + match[0].length);
    if (name === 'seed') continue;
    if (PHYSICAL_MEASUREMENT_UNIT.test(suffix)) continue;
    if ((name === 'width' || name === 'height') && PIXEL_UNIT.test(suffix)) return true;
    return true;
  }
  return false;
}

function normalizeAlias(value) {
  return value.toLocaleLowerCase('en-US').replace(/\+\+/gu, 'pp').replace(/[\s:_=-]+/gu, '');
}

function containsKnownAlias(value, prefix, aliases) {
  let remaining = value;
  while (remaining.length > 0) {
    const prefixMatch = prefix.exec(remaining);
    if (!prefixMatch) return false;
    const nextOffset = prefixMatch.index + prefixMatch[0].length;
    const tokenMatch = ALIAS_TOKENS.exec(remaining.slice(nextOffset));
    if (tokenMatch) {
      const tokens = tokenMatch[0].split(/[\s:_=-]+/u);
      let candidate = '';
      for (const token of tokens) {
        candidate += normalizeAlias(token);
        if (aliases.has(candidate)) return true;
      }
    }
    remaining = remaining.slice(nextOffset);
  }
  return false;
}

function containsSamplerOrScheduler(value) {
  return EXPLICIT_SAMPLER_DIRECTIVE.test(value)
    || containsBareSamplerDirective(value)
    || containsContextualSamplerDirective(value)
    || containsKnownAlias(value, SAMPLER_PREFIX, SAMPLER_ALIASES)
    || containsKnownAlias(value, SCHEDULER_PREFIX, SCHEDULER_ALIASES);
}

function isTechnicalIdentifier(identifier) {
  return /[0-9+_-]/u.test(identifier)
    || /\.(?=[a-z0-9])/iu.test(identifier)
    || (/^[a-z]/u.test(identifier) && /[A-Z]/u.test(identifier.slice(1)));
}

function containsBareSamplerDirective(value) {
  const match = /^(sampler(?:[\s:_=-]+name)?|scheduler)\s+([a-z][a-z0-9+._-]*)\s*(?:[.!?。！？]+)?$/iu.exec(value);
  if (!match) return false;
  const kind = match[1].toLocaleLowerCase('en-US').startsWith('sampler') ? 'sampler' : 'scheduler';
  const identifier = match[2];
  const aliases = kind === 'sampler' ? SAMPLER_ALIASES : SCHEDULER_ALIASES;
  return /^[a-z]/u.test(identifier)
    || aliases.has(normalizeAlias(identifier))
    || isTechnicalIdentifier(identifier);
}

function containsContextualSamplerDirective(value) {
  const tokens = [...value.matchAll(TECHNICAL_WORD)].map((match) => {
    const raw = match[0].replace(TERMINAL_SENTENCE_PUNCTUATION, '');
    return {
      raw,
      lower: raw.toLocaleLowerCase('en-US'),
      start: match.index,
      end: match.index + raw.length,
    };
  }).filter((token) => token.raw.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokens[index].lower;
    if (kind !== 'sampler' && kind !== 'scheduler') continue;
    let identifierIndex = index + 1;
    if (kind === 'sampler' && tokens[identifierIndex]?.lower === 'name') identifierIndex += 1;
    const identifier = tokens[identifierIndex];
    if (!identifier) continue;
    const separator = value.slice(tokens[index].end, identifier.start);
    if (!/^[\s:_=-]+$/u.test(separator)) continue;

    const aliases = kind === 'sampler' ? SAMPLER_ALIASES : SCHEDULER_ALIASES;
    const normalizedIdentifier = normalizeAlias(identifier.raw);
    const technicalIdentifier = isTechnicalIdentifier(identifier.raw);
    if (aliases.has(normalizedIdentifier) || technicalIdentifier) return true;

    const before = tokens.slice(Math.max(0, index - 4), index).map((token) => token.lower);
    const after = tokens.slice(identifierIndex + 1, identifierIndex + 5).map((token) => token.lower);
    if (/^[a-z]/u.test(identifier.raw)
      && before.some((token) => SAMPLER_RESTRICTED_ACTION.has(token))) {
      return true;
    }
    const joinedPrefix = before.at(-1);
    if ((joinedPrefix === 'using' || joinedPrefix === 'with')
      && before.some((token) => SAMPLER_PREFIX_TECHNICAL.has(token))) {
      return true;
    }
    if (SAMPLER_SUFFIX_TECHNICAL.has(after[0])) return true;
    if (after[0] === 'for' && SAMPLER_SUFFIX_TECHNICAL.has(after[1])) return true;
    if (after[0] === 'to' && SAMPLER_SUFFIX_TECHNICAL.has(after[1])) return true;
  }
  return false;
}

function containsTechnicalParameter(value) {
  return EXPLICIT_NUMERIC_PARAMETER.test(value)
    || ADJACENT_NUMERIC_PARAMETER.test(value)
    || UNAMBIGUOUS_NUMERIC_PARAMETER.test(value)
    || containsAmbiguousNumericParameter(value)
    || containsSamplerOrScheduler(value)
    || BARE_SAMPLER_SIGNATURE.test(value);
}

function containsProviderOrWorkflowTerm(value) {
  return PROVIDER_OR_WORKFLOW_TERM.test(value)
    || TECHNICAL_RESOURCE_CONTEXT.test(value)
    || AMBIGUOUS_PROVIDER_CONTEXT.test(value)
    || ASCII_PROVIDER_GENERATION_ACTION.test(value)
    || CHINESE_PROVIDER_TERM.test(value)
    || CHINESE_PROVIDER_CONTEXT.test(value)
    || RUNWAY_PROVIDER_CONTEXT.test(value)
    || KLING_PROVIDER_CONTEXT.test(value);
}

function isProviderNeutralText(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  let normalized;
  try {
    normalized = value.normalize('NFKC');
  } catch {
    return false;
  }

  normalized = normalized.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu, '-');

  return !CONTROL_OR_FORMAT.test(normalized)
    && !HIERARCHICAL_URI.test(normalized)
    && !OPAQUE_URI.test(normalized)
    && !RELATIVE_PATH.test(normalized)
    && !HOME_OR_ENV_PATH.test(normalized)
    && !WINDOWS_DRIVE_OR_UNC_PATH.test(normalized)
    && !WINDOWS_ROOT_RELATIVE_PATH.test(normalized)
    && !ABSOLUTE_PATH.test(normalized)
    && !UNIX_ROOT_PATH.test(normalized)
    && !PATH_AFTER_INTENT.test(normalized)
    && !MODEL_OR_WORKFLOW_FILE.test(normalized)
    && !FILE_AFTER_INTENT.test(normalized)
    && !COMMAND_OR_TEMPLATE_SYNTAX.test(normalized)
    && !containsTechnicalParameter(normalized)
    && !containsProviderOrWorkflowTerm(normalized);
}

module.exports = {
  isProviderNeutralText,
};
