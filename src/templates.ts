import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config, Contact } from './types.ts';

export interface Rendered {
  subject: string;
  body: string;
}

export class TemplateError extends Error {}

/**
 * Templates are plain text: a `Subject:` line, a blank line, then the body.
 * Variables are {{snake_case}} and every one of them must resolve — a missing
 * value throws rather than shipping "Hi ," to a real person.
 */
export function render(templateFile: string, contact: Contact, cfg: Config): Rendered {
  const raw = readFileSync(resolve(process.cwd(), 'templates', templateFile), 'utf8');
  const match = raw.match(/^Subject:\s*(.+?)\r?\n\r?\n([\s\S]*)$/);
  if (!match) {
    throw new TemplateError(
      `${templateFile}: expected a "Subject: ..." line, a blank line, then the body.`,
    );
  }
  const [, subjectTemplate, bodyTemplate] = match;

  const vars: Record<string, string | null> = {
    first_name: clean(contact.first_name),
    last_name: clean(contact.last_name),
    full_name: [clean(contact.first_name), clean(contact.last_name)].filter(Boolean).join(' ') || null,
    title: clean(contact.title),
    company: clean(contact.company),
    my_name: cfg.me.name,
    signature: cfg.signature,
  };

  return {
    subject: substitute(subjectTemplate, vars, templateFile).trim(),
    body: substitute(bodyTemplate, vars, templateFile).trim() + '\n',
  };
}

function clean(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length ? t : null;
}

function substitute(
  text: string,
  vars: Record<string, string | null>,
  templateFile: string,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new TemplateError(`${templateFile}: unknown variable {{${key}}}.`);
    }
    const value = vars[key];
    if (value === null) {
      throw new TemplateError(`missing value for {{${key}}}`);
    }
    return value;
  });
}
