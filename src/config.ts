import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.ts';

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

export const configExists = (): boolean => existsSync(CONFIG_PATH);

/** Validate then persist. Throws on anything that would break a later send. */
export function saveConfig(input: unknown): Config {
  const c = input as Config;
  if (!c?.me?.name?.trim()) throw new Error('Your name is required.');
  if (!c?.me?.email?.trim()) throw new Error('Your Gmail address is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.me.email)) throw new Error('That email looks invalid.');

  const cap = Number(c.dailyCap);
  if (!Number.isFinite(cap) || cap < 1) throw new Error('Daily cap must be at least 1.');

  const attachTo = c.resume?.attachTo ?? 'none';
  if (!['none', 'initial', 'followups', 'all'].includes(attachTo)) {
    throw new Error(`Unknown attachTo value: ${attachTo}`);
  }

  const clean: Config = {
    me: { name: c.me.name.trim(), email: c.me.email.trim().toLowerCase() },
    signature: typeof c.signature === 'string' ? c.signature : '',
    dailyCap: Math.floor(cap),
    initialTemplate: c.initialTemplate || 'initial.txt',
    followUps: Array.isArray(c.followUps) ? c.followUps : [],
    resume: { file: c.resume?.file ?? null, attachTo },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
  return clean;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      'No config.json found. Copy config.example.json to config.json and fill in your name, email and signature.',
    );
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config;
  // Older config files predate the resume section.
  cfg.resume ??= { file: null, attachTo: 'none' };

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
