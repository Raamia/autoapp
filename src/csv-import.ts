import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import { upsertContact, isSuppressed } from './db.ts';

/** Apollo's column names drift between export types, so match on several aliases. */
const FIELD_ALIASES: Record<string, string[]> = {
  email: ['email', 'emails', 'primaryemail', 'workemail'],
  first_name: ['firstname', 'first'],
  last_name: ['lastname', 'last'],
  title: ['title', 'jobtitle', 'position'],
  company: ['company', 'companyname', 'companynameforemails', 'organization', 'account'],
  linkedin_url: ['personlinkedinurl', 'linkedinurl', 'linkedin'],
};

const normalizeKey = (k: string): string => k.toLowerCase().replace(/[^a-z]/g, '');

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: { reason: string; row: number; value?: string }[];
}

export function importCsv(path: string): ImportResult {
  const rows = parse(readFileSync(path, 'utf8'), {
    columns: (header: string[]) => header.map(normalizeKey),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  const result: ImportResult = { inserted: 0, updated: 0, skipped: [] };
  const source = basename(path);
  const seenInFile = new Set<string>();

  rows.forEach((row, i) => {
    const rowNum = i + 2; // +1 for zero-index, +1 for the header line
    const pick = (field: string): string | null => {
      for (const alias of FIELD_ALIASES[field]) {
        const v = row[alias];
        if (v && v.trim()) return v.trim();
      }
      return null;
    };

    const email = pick('email')?.toLowerCase();

    if (!email) {
      result.skipped.push({ reason: 'no email in row', row: rowNum });
      return;
    }
    // Apollo writes placeholders like this when the address isn't revealed.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes('not_unlocked')) {
      result.skipped.push({ reason: 'unusable email', row: rowNum, value: email });
      return;
    }
    if (seenInFile.has(email)) {
      result.skipped.push({ reason: 'duplicate within file', row: rowNum, value: email });
      return;
    }
    if (isSuppressed(email)) {
      result.skipped.push({ reason: 'suppressed', row: rowNum, value: email });
      return;
    }
    seenInFile.add(email);

    const outcome = upsertContact({
      email,
      first_name: pick('first_name'),
      last_name: pick('last_name'),
      title: pick('title'),
      company: pick('company'),
      linkedin_url: pick('linkedin_url'),
      source,
    });
    if (outcome === 'inserted') result.inserted++;
    else result.updated++;
  });

  return result;
}
