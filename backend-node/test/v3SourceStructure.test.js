const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapModelRangeToSource,
  parseSourceStructure,
  isSourceStructureError,
} = require('../src/narrative/sourceStructure');

function pointOffset(text, codeUnitOffset) {
  return Array.from(text.slice(0, codeUnitOffset)).length;
}

function expectStructureError(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(isSourceStructureError(error), true);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
}

test('builds an ATX heading tree and traceable Markdown paragraphs', () => {
  const text = [
    '# 第一章',
    '',
    '**林舟**走进[旧车站](https://example.test/station)，看见😀。',
    '',
    '## 雨夜',
    '',
    '> 她说：“别过来。”',
  ].join('\n');

  const result = parseSourceStructure({ text, sourceType: 'markdown' });

  assert.equal(result.schemaVersion, 'source-structure.v1');
  assert.equal(result.textCodePoints, Array.from(text).length);
  assert.deepEqual(result.headings.map(({ level, title, path }) => ({ level, title, path })), [
    { level: 1, title: '第一章', path: ['第一章'] },
    { level: 2, title: '雨夜', path: ['第一章', '雨夜'] },
  ]);
  assert.equal(result.paragraphs.length, 2);
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.headingPath), [
    ['第一章'],
    ['第一章', '雨夜'],
  ]);
  assert.equal(result.paragraphs[0].rawText, '**林舟**走进[旧车站](https://example.test/station)，看见😀。');
  assert.equal(result.paragraphs[0].modelText, '林舟走进旧车站，看见😀。');
  assert.equal(result.paragraphs[1].modelText, '她说：“别过来。”');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.paragraphs[0].offsetMap), true);
});

test('maps cleaned model ranges back to exact Unicode source offsets', () => {
  const text = '# 章😀\n\n**甲**看见[乙😀](https://example.test)。';
  const result = parseSourceStructure({ text, sourceType: 'markdown' });
  const paragraph = result.paragraphs[0];
  const modelStart = Array.from(paragraph.modelText.slice(0, paragraph.modelText.indexOf('乙'))).length;
  const modelEnd = modelStart + Array.from('乙😀').length;

  const mapped = mapModelRangeToSource(paragraph, modelStart, modelEnd);
  const sourceUnitStart = text.indexOf('乙😀');
  const sourceUnitEnd = sourceUnitStart + '乙😀'.length;
  assert.deepEqual(mapped, {
    sourceStart: pointOffset(text, sourceUnitStart),
    sourceEnd: pointOffset(text, sourceUnitEnd),
  });
  assert.equal(Array.from(text).slice(mapped.sourceStart, mapped.sourceEnd).join(''), '乙😀');
});

test('supports Setext headings and ignores heading markers inside fenced code', () => {
  const text = [
    '第二章',
    '---',
    '',
    '正文一。',
    '',
    '```text',
    '# 这不是标题',
    '```',
    '',
    '### 真标题',
    '正文二。',
  ].join('\n');

  const result = parseSourceStructure({ text, sourceType: 'markdown' });

  assert.deepEqual(result.headings.map(({ level, title }) => ({ level, title })), [
    { level: 2, title: '第二章' },
    { level: 3, title: '真标题' },
  ]);
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.modelText), [
    '正文一。',
    '# 这不是标题',
    '正文二。',
  ]);
  assert.deepEqual(result.paragraphs[1].headingPath, ['第二章']);
  assert.deepEqual(result.paragraphs[2].headingPath, ['第二章', '真标题']);
});

test('keeps TXT paragraphs unchanged while preserving exact ranges', () => {
  const text = '第一段😀。\n仍是第一段。\n\n第二段。';
  const result = parseSourceStructure({ text, sourceType: 'txt' });

  assert.deepEqual(result.headings, []);
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.modelText), [
    '第一段😀。\n仍是第一段。',
    '第二段。',
  ]);
  for (const paragraph of result.paragraphs) {
    assert.equal(paragraph.modelText, paragraph.rawText);
    assert.equal(
      Array.from(text).slice(paragraph.sourceStart, paragraph.sourceEnd).join(''),
      paragraph.rawText,
    );
  }
});

test('strips bounded Markdown presentation syntax without losing source evidence', () => {
  const text = '- `动作`与~~删减~~，以及![门](asset://door)。\n\n<div>忽略标签</div>保留文字。';
  const result = parseSourceStructure({ text, sourceType: 'markdown' });

  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.modelText), [
    '动作与删减，以及门。',
    '忽略标签保留文字。',
  ]);
  for (const paragraph of result.paragraphs) {
    for (const segment of paragraph.offsetMap) {
      assert.equal(segment.modelStart < segment.modelEnd, true);
      assert.equal(segment.sourceStart < segment.sourceEnd, true);
    }
  }
});

test('preserves literal or unclosed Markdown punctuation', () => {
  const text = '角色_A 与 2 < 3 > 1，保留*未闭合，以及 `未闭合。';
  const paragraph = parseSourceStructure({ text, sourceType: 'markdown' }).paragraphs[0];
  assert.equal(paragraph.modelText, text);
});

test('rejects invalid normalization, source types and hostile option shapes', () => {
  expectStructureError('SOURCE_STRUCTURE_INVALID', () => parseSourceStructure({
    text: 'line one\r\nline two',
    sourceType: 'txt',
  }));
  expectStructureError('SOURCE_STRUCTURE_INVALID', () => parseSourceStructure({
    text: '',
    sourceType: 'markdown',
  }));
  expectStructureError('SOURCE_STRUCTURE_INVALID', () => parseSourceStructure({
    text: 'safe',
    sourceType: 'docx',
  }));

  let getterReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'text', {
    get() {
      getterReads += 1;
      return 'private';
    },
  });
  Object.defineProperty(hostile, 'sourceType', { value: 'txt' });
  expectStructureError('SOURCE_STRUCTURE_INVALID', () => parseSourceStructure(hostile));
  assert.equal(getterReads, 0);
});

test('rejects invalid model-to-source ranges without exposing paragraph text', () => {
  const paragraph = parseSourceStructure({
    text: '**private** text',
    sourceType: 'markdown',
  }).paragraphs[0];

  for (const range of [[-1, 1], [0, 100], [2, 1], [0.5, 1]]) {
    expectStructureError('SOURCE_STRUCTURE_OFFSET_INVALID', () => mapModelRangeToSource(
      paragraph,
      range[0],
      range[1],
    ));
  }
});

test('bounds adversarial line counts before allocating unbounded structure arrays', () => {
  const text = 'x\n'.repeat(200000);
  expectStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED', () => parseSourceStructure({
    text,
    sourceType: 'txt',
  }));
});

test('handles long malformed link and tag prefixes without losing literal text', () => {
  const brackets = '['.repeat(20000);
  const tags = '<a'.repeat(20000);
  const text = `${brackets}label](url)\n\n${tags}>正文`;
  const result = parseSourceStructure({ text, sourceType: 'markdown' });

  const first = result.paragraphs
    .filter((fragment) => fragment.paragraphOrdinal === 0)
    .map((fragment) => fragment.modelText)
    .join('');
  const second = result.paragraphs
    .filter((fragment) => fragment.paragraphOrdinal === 1)
    .map((fragment) => fragment.modelText)
    .join('');
  assert.equal(first, `${'['.repeat(19999)}label`);
  assert.equal(second, `${'<a'.repeat(19999)}正文`);
});

test('bounds Markdown presentation ranges before syntax-heavy input can amplify memory', () => {
  const text = '*a*'.repeat(50001);
  expectStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED', () => parseSourceStructure({
    text,
    sourceType: 'markdown',
  }));
});

test('emits explicit Unicode-safe fragments for overlong paragraphs', () => {
  const text = '😀'.repeat(3001);
  const result = parseSourceStructure({ text, sourceType: 'txt' });

  assert.equal(result.paragraphs.length, 2);
  assert.deepEqual(result.paragraphs.map((fragment) => ({
    paragraphOrdinal: fragment.paragraphOrdinal,
    fragmentOrdinal: fragment.fragmentOrdinal,
    fragmentCount: fragment.fragmentCount,
    sourceStart: fragment.sourceStart,
    sourceEnd: fragment.sourceEnd,
  })), [
    { paragraphOrdinal: 0, fragmentOrdinal: 0, fragmentCount: 2, sourceStart: 0, sourceEnd: 3000 },
    { paragraphOrdinal: 0, fragmentOrdinal: 1, fragmentCount: 2, sourceStart: 3000, sourceEnd: 3001 },
  ]);
  assert.equal(result.paragraphs.map((fragment) => fragment.rawText).join(''), text);
  assert.equal(result.paragraphs.every((fragment) => Array.from(fragment.rawText).length <= 3000), true);
});

test('shares Markdown range and mapping budgets across the complete document', () => {
  const syntaxHeavyParagraph = '*a*'.repeat(50000);
  const accepted = parseSourceStructure({
    text: syntaxHeavyParagraph,
    sourceType: 'markdown',
  });
  assert.equal(accepted.paragraphs.map((fragment) => fragment.modelText).join(''), 'a'.repeat(50000));

  expectStructureError('SOURCE_STRUCTURE_LIMIT_EXCEEDED', () => parseSourceStructure({
    text: `${syntaxHeavyParagraph}\n\n${syntaxHeavyParagraph}`,
    sourceType: 'markdown',
  }));
});

test('keeps fenced code literal and consumes balanced inline-link destinations', () => {
  const text = [
    '```markdown',
    '*literal* [x](https://a/(b))',
    '```',
    '',
    '[x](https://a/(b))',
  ].join('\n');
  const result = parseSourceStructure({ text, sourceType: 'markdown' });

  assert.equal(result.paragraphs[0].modelText, '*literal* [x](https://a/(b))');
  assert.equal(result.paragraphs[1].modelText, 'x');
});

test('recognizes ATX and Setext headings after bounded block prefixes', () => {
  const text = [
    '> # 引用章',
    '',
    '> 正文一。',
    '',
    '> 引用节',
    '> ---',
    '',
    '正文二。',
  ].join('\n');
  const result = parseSourceStructure({ text, sourceType: 'markdown' });

  assert.deepEqual(result.headings.map(({ level, title, path }) => ({ level, title, path })), [
    { level: 1, title: '引用章', path: ['引用章'] },
    { level: 2, title: '引用节', path: ['引用章', '引用节'] },
  ]);
  assert.deepEqual(result.paragraphs.map((paragraph) => paragraph.modelText), ['正文一。', '正文二。']);
  for (const heading of result.headings) {
    assert.equal(Array.from(text).slice(heading.titleStart, heading.titleEnd).join(''), heading.title);
  }
});

test('keeps fenced blocks continuous across blank lines and strips only their container prefix', () => {
  const plain = parseSourceStructure({
    text: ['```', 'a', '', 'b', '```'].join('\n'),
    sourceType: 'markdown',
  });
  assert.equal(plain.logicalParagraphCount, 1);
  assert.equal(plain.paragraphs.map((fragment) => fragment.rawText).join(''), 'a\n\nb');
  assert.equal(plain.paragraphs.map((fragment) => fragment.modelText).join(''), 'a\n\nb');

  const quoted = parseSourceStructure({
    text: ['> ```', '> *literal*', '>', '> [x](https://a/(b))', '> ```'].join('\n'),
    sourceType: 'markdown',
  });
  assert.equal(quoted.logicalParagraphCount, 1);
  assert.equal(
    quoted.paragraphs.map((fragment) => fragment.rawText).join(''),
    '> *literal*\n>\n> [x](https://a/(b))',
  );
  assert.equal(
    quoted.paragraphs.map((fragment) => fragment.modelText).join(''),
    '*literal*\n\n[x](https://a/(b))',
  );
});

test('does not close fences or pair Setext headings across different containers', () => {
  const fence = parseSourceStructure({
    text: ['> ```', '> quoted', '```', '> still code', '> ```'].join('\n'),
    sourceType: 'markdown',
  });
  assert.equal(fence.logicalParagraphCount, 1);
  assert.equal(
    fence.paragraphs.map((fragment) => fragment.modelText).join(''),
    'quoted\n```\nstill code',
  );

  for (const text of ['> Quoted title\n---', 'Plain title\n> ---']) {
    const structure = parseSourceStructure({ text, sourceType: 'markdown' });
    assert.deepEqual(structure.headings, []);
  }
});

test('treats marker-only list container lines as empty fenced-code content', () => {
  for (const marker of ['-', '+', '*', '1.', '1)']) {
    const structure = parseSourceStructure({
      text: [`> ${marker} \`\`\``, `> ${marker}`, `> ${marker} \`\`\``].join('\n'),
      sourceType: 'markdown',
    });

    assert.equal(structure.logicalParagraphCount, 1);
    assert.equal(structure.paragraphs.map((fragment) => fragment.rawText).join(''), `> ${marker}`);
    assert.equal(structure.paragraphs.map((fragment) => fragment.modelText).join(''), '');
  }
});

test('keeps a single dash available as a Setext marker outside fenced code', () => {
  for (const [text, title] of [
    ['Title\n-', 'Title'],
    ['> Title\n> -', 'Title'],
    ['> > Nested title\n> > -', 'Nested title'],
  ]) {
    const structure = parseSourceStructure({ text, sourceType: 'markdown' });
    assert.deepEqual(
      structure.headings.map(({ level, title: headingTitle }) => ({ level, title: headingTitle })),
      [{ level: 2, title }],
    );
    assert.equal(structure.paragraphs.length, 0);
  }
});
