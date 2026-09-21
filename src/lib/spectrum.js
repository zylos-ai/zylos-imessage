/**
 * Thin wrapper over the Photon SDK (`@spectrum-ts/core` + `@spectrum-ts/imessage`).
 *
 * The SDK is imported lazily so the rest of the component — and its unit
 * tests — can run without the packages installed or credentials present.
 *
 * API shapes here were taken from the published `.d.ts` files, not from prose
 * docs; see workspace/photon-imessage-api-notes.md.
 */

/**
 * Connect to Photon.
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} [opts.logLevel]
 * @param {Function} [opts.importModule]  test seam
 * @returns {Promise<{spectrum: object, im: object, text: Function}>}
 */
export async function createSpectrumClient({
  projectId,
  projectSecret,
  logLevel = 'info',
  importModule = (specifier) => import(specifier)
}) {
  if (!projectId || !projectSecret) {
    throw new Error('projectId and projectSecret are both required');
  }

  const core = await importModule('@spectrum-ts/core');
  const { imessage } = await importModule('@spectrum-ts/imessage');

  const spectrum = await core.Spectrum({
    projectId,
    projectSecret,
    // The parameter is optional; the shared free-tier number is provisioned on
    // the Photon side, so no local client config is passed.
    providers: [imessage.config()],
    options: { logLevel },
    telemetry: false
  });

  return { spectrum, im: imessage(spectrum), text: core.text };
}

/** Pull plain text out of a Message's discriminated-union content. */
export function extractText(message) {
  const content = message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

/** A short human-readable label for the non-text content we cannot forward yet. */
export function describeNonText(message) {
  const type = message?.content?.type;
  if (!type || type === 'text') return null;
  return `[unsupported iMessage content: ${type}]`;
}

/** Normalize the bits of a Space we care about. */
export function describeSpace(space) {
  return {
    id: space?.id ? String(space.id) : null,
    type: space?.type === 'group' ? 'group' : 'dm',
    phone: space?.phone ? String(space.phone) : null
  };
}

/** Normalize the sender, falling back to the DM's phone number when absent. */
export function describeSender(message, space) {
  const sender = message?.sender;
  const id = sender?.id ?? space?.phone ?? null;
  const name = sender?.name ?? sender?.displayName ?? null;
  return { id: id === null ? null : String(id), name: name === null ? null : String(name) };
}
