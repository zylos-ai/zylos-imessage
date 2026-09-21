import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSpectrumClient, extractText, describeNonText, describeSpace, describeSender
} from '../src/lib/spectrum.js';

test('extractText handles the text content shape', () => {
  assert.equal(extractText({ content: { type: 'text', text: 'hi' } }), 'hi');
});

test('extractText handles a plain string and an array of parts', () => {
  assert.equal(extractText({ content: 'hi' }), 'hi');
  assert.equal(
    extractText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }),
    'a\nb'
  );
});

test('extractText returns empty string for non-text and missing content', () => {
  assert.equal(extractText({ content: { type: 'image', url: 'x' } }), '');
  assert.equal(extractText({}), '');
  assert.equal(extractText(null), '');
});

test('describeNonText labels unsupported content and stays quiet for text', () => {
  assert.equal(describeNonText({ content: { type: 'image' } }), '[unsupported iMessage content: image]');
  assert.equal(describeNonText({ content: { type: 'text', text: 'hi' } }), null);
  assert.equal(describeNonText({}), null);
});

test('describeSpace normalises id, type and phone', () => {
  assert.deepEqual(describeSpace({ id: 42, type: 'group', phone: 15555550142 }), {
    id: '42', type: 'group', phone: '15555550142'
  });
  // Anything that is not explicitly a group is treated as a DM.
  assert.equal(describeSpace({ id: 'x' }).type, 'dm');
  assert.equal(describeSpace(null).id, null);
});

test('describeSender falls back to the space phone when there is no sender', () => {
  assert.deepEqual(describeSender({}, { phone: '+15555550142' }), {
    id: '+15555550142', name: null
  });
  assert.deepEqual(describeSender({ sender: { id: 'u1', name: 'Bobo' } }, {}), {
    id: 'u1', name: 'Bobo'
  });
  assert.equal(describeSender({}, {}).id, null);
});

test('createSpectrumClient refuses to connect without both credentials', async () => {
  await assert.rejects(() => createSpectrumClient({ projectId: 'a' }), /both required/);
  await assert.rejects(() => createSpectrumClient({ projectSecret: 'b' }), /both required/);
});

test('createSpectrumClient wires the SDK together as expected', async () => {
  const calls = {};
  const fakeSpectrum = { messages: [], send() {}, stop() {} };
  const fakeIm = { space: { get() {} } };

  const importModule = async (specifier) => {
    if (specifier === '@spectrum-ts/core') {
      return {
        Spectrum: async (opts) => { calls.factory = opts; return fakeSpectrum; },
        text: (t) => ({ type: 'text', text: t })
      };
    }
    if (specifier === '@spectrum-ts/imessage') {
      return {
        imessage: Object.assign(
          (spectrum) => { calls.platformArg = spectrum; return fakeIm; },
          { config: (cfg) => { calls.providerConfig = cfg; return { provider: 'imessage' }; } }
        )
      };
    }
    throw new Error(`unexpected import: ${specifier}`);
  };

  const client = await createSpectrumClient({
    projectId: 'pid', projectSecret: 'secret', logLevel: 'warn', importModule
  });

  assert.equal(calls.factory.projectId, 'pid');
  assert.equal(calls.factory.projectSecret, 'secret');
  assert.equal(calls.factory.options.logLevel, 'warn');
  assert.equal(calls.factory.telemetry, false);
  assert.deepEqual(calls.factory.providers, [{ provider: 'imessage' }]);
  // The shared free-tier number needs no local client config.
  assert.equal(calls.providerConfig, undefined);
  assert.equal(calls.platformArg, fakeSpectrum);
  assert.equal(client.spectrum, fakeSpectrum);
  assert.equal(client.im, fakeIm);
  assert.deepEqual(client.text('hi'), { type: 'text', text: 'hi' });
});
