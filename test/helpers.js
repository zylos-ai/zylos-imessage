import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point HOME at a throwaway directory. config.js resolves DATA_DIR from HOME
 * at module load, so this must run before the module under test is imported.
 */
export function useTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-imessage-test-'));
  process.env.HOME = dir;
  fs.mkdirSync(path.join(dir, 'zylos/components/imessage'), { recursive: true });
  return dir;
}

export function writeConfig(home, config) {
  const file = path.join(home, 'zylos/components/imessage/config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}

export function readConfig(home) {
  const file = path.join(home, 'zylos/components/imessage/config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
