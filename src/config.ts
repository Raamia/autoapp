import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.ts';

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      'No config.json found. Copy config.example.json to config.json and fill in your name, email and signature.',
    );
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;

  if (!cfg.me?.email) throw new Error('config.json: me.email is required.');
  if (!cfg.me?.name) throw new Error('config.json: me.name is required.');
  if (!cfg.dailyCap || cfg.dailyCap < 1) throw new Error('config.json: dailyCap must be >= 1.');

  if (cfg.dailyCap > 50) {
    console.warn(
      `⚠️  dailyCap is ${cfg.dailyCap}. Sustained cold volume above ~40/day from a personal\n` +
        '   Gmail account risks spam-flagging that affects all your mail, not just outreach.',
    );
  }
  return cfg;
}
