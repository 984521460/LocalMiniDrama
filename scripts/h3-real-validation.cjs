#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  createH3LocalVideoInspector,
  createH3Phase7ValidationPlan,
  createH3RealValidationCollector,
  evaluateH3Phase7Evidence,
  validateH3Phase7ValidationPlan,
} = require('../backend-node/src/h3');
const { parseStrictJson } = require('../backend-node/src/security/strictJson');

const MAXIMUM_JSON_BYTES = 32 * 1024 * 1024;
const COMMANDS = new Set(['prepare', 'check', 'receipt', 'gate']);

function invalid() {
  throw new TypeError('Invalid H3 validation command');
}

function exactObject(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])) invalid();
  return value;
}

function commandLine(argv) {
  if (argv.length !== 7 || !COMMANDS.has(argv[2])) invalid();
  const options = Object.create(null);
  for (let index = 3; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--input', '--output'].includes(flag) || Object.hasOwn(options, flag)
      || typeof value !== 'string' || value.length < 1 || value.includes('\0')) invalid();
    options[flag] = path.resolve(value);
  }
  if (!options['--input'] || !options['--output']) invalid();
  return Object.freeze({
    command: argv[2],
    input: options['--input'],
    output: options['--output'],
  });
}

function readJson(filePath) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()
    || stats.size < 1 || stats.size > MAXIMUM_JSON_BYTES) invalid();
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== stats.size || bytes.length > MAXIMUM_JSON_BYTES) invalid();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  return parseStrictJson(text, MAXIMUM_JSON_BYTES);
}

function writeJsonExclusive(filePath, value) {
  const parent = path.dirname(filePath);
  const parentStats = fs.lstatSync(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) invalid();
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.length > MAXIMUM_JSON_BYTES) invalid();
  fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
}

async function execute({ command, input, output }) {
  const parsed = readJson(input);
  let result;
  if (command === 'prepare') {
    result = createH3Phase7ValidationPlan(parsed);
  } else if (command === 'check') {
    result = validateH3Phase7ValidationPlan(parsed);
  } else if (command === 'gate') {
    result = evaluateH3Phase7Evidence(parsed);
  } else {
    const configured = exactObject(parsed, [
      'localRoot', 'ffprobePath', 'ffmpegPath', 'timeoutMs', 'environment', 'receipt',
    ]);
    const inspector = createH3LocalVideoInspector({
      localRoot: configured.localRoot,
      ffprobePath: configured.ffprobePath,
      ffmpegPath: configured.ffmpegPath,
      timeoutMs: configured.timeoutMs,
    });
    result = await createH3RealValidationCollector({
      inspector,
      environment: configured.environment,
    }).collect(configured.receipt);
  }
  writeJsonExclusive(output, result);
}

async function main() {
  await execute(commandLine(process.argv));
}

main().then(() => {
  process.stdout.write('H3 validation artifact created.\n');
}, () => {
  process.stderr.write('H3 validation command failed.\n');
  process.exitCode = 1;
});
