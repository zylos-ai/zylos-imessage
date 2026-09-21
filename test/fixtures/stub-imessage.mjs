/**
 * Stand-in for `@spectrum-ts/imessage`.
 *
 * `imessage.config()` is the provider descriptor handed to Spectrum();
 * `imessage(spectrum)` is the namespace used to resolve a Space by id.
 */

import { record } from './stub-state.mjs';

export function imessage(spectrum) {
  return {
    space: {
      async get(id) {
        record({ event: 'space.get', spaceId: id });
        if (!id || String(id).startsWith('unknown')) return null;
        return { id: String(id), type: 'dm' };
      }
    },
    spectrum
  };
}

imessage.config = () => ({ provider: 'imessage' });
