/**
 * Preloaded via `node --import` so that `src/index.js` runs unmodified while
 * the two Photon packages resolve to local stubs.
 *
 * This is deliberately a loader hook rather than a dependency-injection seam
 * in src/: the point of the integration tests is to exercise the real entry
 * point, including its own import graph and lifecycle, not a rewired copy.
 */

import { registerHooks } from 'node:module';

const STUBS = {
  '@spectrum-ts/core': new URL('./stub-core.mjs', import.meta.url).href,
  '@spectrum-ts/imessage': new URL('./stub-imessage.mjs', import.meta.url).href
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: stub, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
