#!/usr/bin/env node
/**
 * zylos-imessage
 *
 * iMessage communication channel for Zylos agents
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';

// Initialize
console.log(`[imessage] Starting...`);
console.log(`[imessage] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[imessage] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[imessage] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[imessage] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[imessage] Component disabled, stopping...`);
    shutdown();
  }
});

// Main component logic
async function main() {
  // TODO: Implement your component logic here
  //
  // Communication components: set up platform SDK, listen for events, forward to C4
  // Capability components: start HTTP server or other service interface
  // Utility components: run task and exit (remove the keepalive below)

  console.log(`[imessage] Running`);
}

// Graceful shutdown
function shutdown() {
  console.log(`[imessage] Shutting down...`);
  // TODO: Close connections, stop listeners, cleanup
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[imessage] Fatal error:`, err);
  process.exit(1);
});
