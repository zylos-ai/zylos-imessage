import test from 'node:test';
import assert from 'node:assert/strict';

import { stripMarkdown, splitMessage, prepareOutbound } from '../src/lib/format.js';

test('stripMarkdown removes common markdown syntax', () => {
  assert.equal(stripMarkdown('**bold** and _italic_'), 'bold and italic');
  assert.equal(stripMarkdown('`code`'), 'code');
  assert.equal(stripMarkdown('# Heading'), 'Heading');
  assert.equal(stripMarkdown('[link](https://example.com)'), 'link (https://example.com)');
  assert.equal(stripMarkdown('> quoted'), 'quoted');
});

test('stripMarkdown unwraps fenced code blocks including the language tag', () => {
  assert.equal(stripMarkdown('```js\nconst a = 1;\n```'), 'const a = 1;\n');
});

test('splitMessage returns the text unchanged when it fits', () => {
  assert.deepEqual(splitMessage('hello', 100), ['hello']);
});

test('splitMessage returns nothing for empty input', () => {
  assert.deepEqual(splitMessage('', 100), []);
});

test('splitMessage prefers a paragraph boundary', () => {
  const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60);
  const chunks = splitMessage(text, 80);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], 'a'.repeat(60));
  assert.equal(chunks[1], 'b'.repeat(60));
});

test('splitMessage falls back to a word boundary', () => {
  const chunks = splitMessage('word '.repeat(40).trim(), 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 50, `chunk too long: ${chunk.length}`);
    assert.ok(!chunk.startsWith(' ') && !chunk.endsWith(' '));
  }
});

test('splitMessage hard-splits text with no usable boundary', () => {
  const chunks = splitMessage('x'.repeat(250), 100);
  assert.deepEqual(chunks.map(c => c.length), [100, 100, 50]);
});

test('splitMessage terminates on whitespace-heavy input', () => {
  const chunks = splitMessage(' '.repeat(300) + 'end', 50);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks.join(''), 'end');
});

test('splitMessage rejects a nonsensical max length', () => {
  assert.throws(() => splitMessage('abc', 0), /positive integer/);
});

test('prepareOutbound strips markdown by default and honours opting out', () => {
  assert.deepEqual(prepareOutbound('**hi**', { maxLength: 100 }), ['hi']);
  assert.deepEqual(prepareOutbound('**hi**', { maxLength: 100, stripMarkdown: false }), ['**hi**']);
});
