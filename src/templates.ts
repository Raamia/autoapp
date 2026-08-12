import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Config, Contact } from './types.ts';

const TEMPLATE_DIR = resolve(process.cwd(), 'templates');

/**
 * Resolve a template name to a path inside templates/, or throw. The web UI
 * passes this name straight from a request, so "../../token.json" has to die here.
 */
function templatePath(name: string): string {
  if (!/^[A-Za-z0-9._-]+\.txt$/.test(name)) {
    throw new TemplateError(`Invalid template name: ${name}`);
  }
  const full = resolve(TEMPLATE_DIR, name);
  if (!full.startsWith(TEMPLATE_DIR + sep)) {
    throw new TemplateError(`Template escapes the templates directory: ${name}`);
  }
  return full;
}

export const listTemplates = (): string[] =>
  existsSync(TEMPLATE_DIR) ? readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.txt')).sort() : [];

export const readTemplate = (name: string): string => readFileSync(templatePath(name), 'utf8');

export function writeTemplate(name: string, content: string): void {
  // Fail before saving rather than at send time, when a real person is the test.
  parseTemplate(content, name);
  writeFileSync(templatePath(name), content);
}

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
function parseTemplate(raw: string, name: string): [string, string] {
  const match = raw.match(/^Subject:\s*(.+?)\r?\n\r?\n([\s\S]*)$/);
  if (!match) {
    throw new TemplateError(
      `${name}: expected a "Subject: ..." line, a blank line, then the body.`,
    );
  }
  return [match[1], match[2]];
}

export function render(templateFile: string, contact: Contact, cfg: Config): Rendered {
  const raw = readTemplate(templateFile);
  const [subjectTemplate, bodyTemplate] = parseTemplate(raw, templateFile);

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
