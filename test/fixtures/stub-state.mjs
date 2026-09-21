/**
 * Shared state for the Photon SDK stub.
 *
 * The stub is driven by a scenario file (IMESSAGE_STUB_SCENARIO) and records
 * everything the daemon does to it in an event log (IMESSAGE_STUB_EVENTS), so
 * an integration test can assert on real behaviour of src/index.js rather
 * than on a re-implementation of it.
 */

import fs from 'node:fs';

const scenarioPath = process.env.IMESSAGE_STUB_SCENARIO;
const eventsPath = process.env.IMESSAGE_STUB_EVENTS;

export const scenario = scenarioPath
  ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))
  : { connections: [] };

export function record(event) {
  if (!eventsPath) return;
  fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');
}

let connectionCount = 0;
export function nextConnection() {
  const index = connectionCount;
  connectionCount += 1;
  // Past the end of the script, behave like a healthy idle connection.
  return scenario.connections[index] || { messages: [], thenHang: true };
}

export function connectionsSoFar() {
  return connectionCount;
}
