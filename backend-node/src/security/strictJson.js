'use strict';

const JSON_WHITESPACE = new Set(['\t', '\n', '\r', ' ']);
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX = /^[0-9a-fA-F]$/u;

function invalid() {
  throw new TypeError('Invalid JSON data');
}

function parseStrictJson(text, maximumBytes = 1024 * 1024) {
  if (typeof text !== 'string' || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1 || Buffer.byteLength(text, 'utf8') > maximumBytes) invalid();

  let cursor = 0;

  function whitespace() {
    while (cursor < text.length && JSON_WHITESPACE.has(text[cursor])) cursor += 1;
  }

  function stringValue() {
    if (text[cursor] !== '"') invalid();
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x22) {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch {
          return invalid();
        }
      }
      if (code === 0x5c) {
        cursor += 1;
        if (cursor >= text.length) invalid();
        const escape = text[cursor];
        if (escape === 'u') {
          if (cursor + 4 >= text.length) invalid();
          for (let offset = 1; offset <= 4; offset += 1) {
            if (!HEX.test(text[cursor + offset])) invalid();
          }
          cursor += 5;
          continue;
        }
        if (!SIMPLE_ESCAPES.has(escape)) invalid();
        cursor += 1;
        continue;
      }
      if (code < 0x20) invalid();
      cursor += 1;
    }
    return invalid();
  }

  function numberValue() {
    if (text[cursor] === '-') cursor += 1;
    if (text[cursor] === '0') {
      cursor += 1;
    } else {
      if (text[cursor] < '1' || text[cursor] > '9') invalid();
      while (text[cursor] >= '0' && text[cursor] <= '9') cursor += 1;
    }
    if (text[cursor] === '.') {
      cursor += 1;
      if (text[cursor] < '0' || text[cursor] > '9') invalid();
      while (text[cursor] >= '0' && text[cursor] <= '9') cursor += 1;
    }
    if (text[cursor] === 'e' || text[cursor] === 'E') {
      cursor += 1;
      if (text[cursor] === '+' || text[cursor] === '-') cursor += 1;
      if (text[cursor] < '0' || text[cursor] > '9') invalid();
      while (text[cursor] >= '0' && text[cursor] <= '9') cursor += 1;
    }
  }

  function literal(expected) {
    if (text.slice(cursor, cursor + expected.length) !== expected) invalid();
    cursor += expected.length;
  }

  function arrayValue() {
    cursor += 1;
    whitespace();
    if (text[cursor] === ']') {
      cursor += 1;
      return;
    }
    while (cursor < text.length) {
      value();
      whitespace();
      if (text[cursor] === ']') {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ',') invalid();
      cursor += 1;
      whitespace();
    }
    invalid();
  }

  function objectValue() {
    cursor += 1;
    whitespace();
    const keys = new Set();
    if (text[cursor] === '}') {
      cursor += 1;
      return;
    }
    while (cursor < text.length) {
      const key = stringValue();
      if (keys.has(key)) invalid();
      keys.add(key);
      whitespace();
      if (text[cursor] !== ':') invalid();
      cursor += 1;
      whitespace();
      value();
      whitespace();
      if (text[cursor] === '}') {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ',') invalid();
      cursor += 1;
      whitespace();
    }
    invalid();
  }

  function value() {
    whitespace();
    const token = text[cursor];
    if (token === '{') objectValue();
    else if (token === '[') arrayValue();
    else if (token === '"') stringValue();
    else if (token === 't') literal('true');
    else if (token === 'f') literal('false');
    else if (token === 'n') literal('null');
    else if (token === '-' || (token >= '0' && token <= '9')) numberValue();
    else invalid();
  }

  value();
  whitespace();
  if (cursor !== text.length) invalid();
  try {
    return JSON.parse(text);
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({ parseStrictJson });
