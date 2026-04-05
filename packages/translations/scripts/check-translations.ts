#!/usr/bin/env npx tsx
/**
 * Translation completeness checker
 *
 * Compares translation files across languages to find:
 * - Missing files (namespace exists in base but not target)
 * - Missing keys (key exists in base but not target)
 * - Extra keys (key exists in target but not base) - optional with --strict
 *
 * Usage:
 *   pnpm check                  # Check all languages against en
 *   pnpm check --strict         # Also report extra keys
 *   pnpm check --lang=de-DE     # Check only German
 *   pnpm check --fix            # Add missing keys using English defaults
 *   pnpm check --fix --dry-run  # Preview fixes without writing files
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '../src/locales');
const BASE_LANG = 'en';

interface TranslationObject {
  [key: string]: string | TranslationObject;
}

interface CheckResult {
  missingFiles: string[];
  missingKeys: { file: string; keys: string[] }[];
  extraKeys: { file: string; keys: string[] }[];
}

interface FixResult {
  filesCreated: string[];
  keysAdded: { file: string; count: number }[];
}

function getAllKeys(obj: TranslationObject, prefix = ''): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...getAllKeys(value as TranslationObject, fullKey));
    } else if (Array.isArray(value)) {
      console.warn(`Warning: Array value at '${fullKey}' is not supported`);
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

function getValueAtPath(
  obj: TranslationObject,
  keyPath: string
): string | TranslationObject | undefined {
  const parts = keyPath.split('.');
  let current: string | TranslationObject | undefined = obj;

  for (const part of parts) {
    if (current === undefined || typeof current === 'string') {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function setValueAtPath(
  obj: TranslationObject,
  keyPath: string,
  value: string | TranslationObject
): void {
  const parts = keyPath.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] === 'string') {
      current[part] = {};
    }
    current = current[part] as TranslationObject;
  }

  current[parts[parts.length - 1]] = value;
}

function sortObjectKeys(obj: TranslationObject): TranslationObject {
  const sorted: TranslationObject = {};
  const keys = Object.keys(obj).sort();

  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'object' && value !== null) {
      sorted[key] = sortObjectKeys(value as TranslationObject);
    } else {
      sorted[key] = value;
    }
  }

  return sorted;
}

function getLanguages(): string[] {
  return fs.readdirSync(LOCALES_DIR).filter((name) => {
    const stat = fs.statSync(path.join(LOCALES_DIR, name));
    return stat.isDirectory() && !name.startsWith('_') && name !== BASE_LANG;
  });
}

function languageExists(lang: string): boolean {
  const langDir = path.join(LOCALES_DIR, lang);
  return fs.existsSync(langDir) && fs.statSync(langDir).isDirectory();
}

function getNamespaceFiles(lang: string): string[] {
  const langDir = path.join(LOCALES_DIR, lang);
  if (!fs.existsSync(langDir)) return [];

  return fs
    .readdirSync(langDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace('.json', ''));
}

function loadTranslations(lang: string, namespace: string): TranslationObject | null {
  const filePath = path.join(LOCALES_DIR, lang, `${namespace}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error parsing ${filePath}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function saveTranslations(lang: string, namespace: string, translations: TranslationObject): void {
  const filePath = path.join(LOCALES_DIR, lang, `${namespace}.json`);
  const content = JSON.stringify(sortObjectKeys(translations), null, 2) + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

function checkLanguage(targetLang: string, strict: boolean): CheckResult {
  const result: CheckResult = {
    missingFiles: [],
    missingKeys: [],
    extraKeys: [],
  };

  const baseNamespaces = getNamespaceFiles(BASE_LANG);
  const targetNamespaces = new Set(getNamespaceFiles(targetLang));

  // Check for missing files
  for (const namespace of baseNamespaces) {
    if (!targetNamespaces.has(namespace)) {
      result.missingFiles.push(`${namespace}.json`);
      continue;
    }

    const baseTranslations = loadTranslations(BASE_LANG, namespace);
    const targetTranslations = loadTranslations(targetLang, namespace);

    if (!baseTranslations || !targetTranslations) continue;

    const baseKeys = getAllKeys(baseTranslations);
    const targetKeySet = new Set(getAllKeys(targetTranslations));

    // Find missing keys (O(n) with Set)
    const missingKeys = baseKeys.filter((key) => !targetKeySet.has(key));
    if (missingKeys.length > 0) {
      result.missingKeys.push({ file: `${namespace}.json`, keys: missingKeys });
    }

    // Find extra keys (only in strict mode)
    if (strict) {
      const baseKeySet = new Set(baseKeys);
      const extraKeys = [...targetKeySet].filter((key) => !baseKeySet.has(key));
      if (extraKeys.length > 0) {
        result.extraKeys.push({ file: `${namespace}.json`, keys: extraKeys });
      }
    }
  }

  // Check for extra files (only in strict mode)
  if (strict) {
    const baseNamespaceSet = new Set(baseNamespaces);
    for (const namespace of targetNamespaces) {
      if (!baseNamespaceSet.has(namespace)) {
        result.extraKeys.push({
          file: `${namespace}.json`,
          keys: ['(entire file not in base language)'],
        });
      }
    }
  }

  return result;
}

function fixLanguage(targetLang: string, dryRun: boolean): FixResult {
  const result: FixResult = {
    filesCreated: [],
    keysAdded: [],
  };

  const baseNamespaces = getNamespaceFiles(BASE_LANG);
  const targetNamespaces = new Set(getNamespaceFiles(targetLang));

  // Ensure target language directory exists
  const targetDir = path.join(LOCALES_DIR, targetLang);
  if (!fs.existsSync(targetDir) && !dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  for (const namespace of baseNamespaces) {
    const baseTranslations = loadTranslations(BASE_LANG, namespace);
    if (!baseTranslations) continue;

    let targetTranslations = loadTranslations(targetLang, namespace);
    const isNewFile = !targetNamespaces.has(namespace);

    if (isNewFile) {
      // Create new file with all base translations
      targetTranslations = JSON.parse(JSON.stringify(baseTranslations));
      result.filesCreated.push(`${namespace}.json`);
    } else if (targetTranslations) {
      // Add missing keys to existing file
      const baseKeys = getAllKeys(baseTranslations);
      const targetKeySet = new Set(getAllKeys(targetTranslations));
      const missingKeys = baseKeys.filter((key) => !targetKeySet.has(key));

      if (missingKeys.length > 0) {
        for (const key of missingKeys) {
          const value = getValueAtPath(baseTranslations, key);
          if (value !== undefined) {
            setValueAtPath(targetTranslations, key, value);
          }
        }
        result.keysAdded.push({ file: `${namespace}.json`, count: missingKeys.length });
      }
    }

    if (
      targetTranslations &&
      (isNewFile || result.keysAdded.some((k) => k.file === `${namespace}.json`))
    ) {
      if (!dryRun) {
        saveTranslations(targetLang, namespace, targetTranslations);
      }
    }
  }

  return result;
}

function printResult(lang: string, result: CheckResult): boolean {
  let hasIssues = false;

  if (result.missingFiles.length > 0) {
    hasIssues = true;
    console.log(`\n  Missing files:`);
    for (const file of result.missingFiles) {
      console.log(`    - ${file}`);
    }
  }

  if (result.missingKeys.length > 0) {
    hasIssues = true;
    console.log(`\n  Missing keys:`);
    for (const { file, keys } of result.missingKeys) {
      console.log(`    ${file}:`);
      for (const key of keys) {
        console.log(`      - ${key}`);
      }
    }
  }

  if (result.extraKeys.length > 0) {
    console.log(`\n  Extra keys (not in ${BASE_LANG}):`);
    for (const { file, keys } of result.extraKeys) {
      console.log(`    ${file}:`);
      for (const key of keys) {
        console.log(`      - ${key}`);
      }
    }
  }

  return hasIssues;
}

function printFixResult(lang: string, result: FixResult, dryRun: boolean): void {
  const prefix = dryRun ? '(dry-run) ' : '';

  if (result.filesCreated.length > 0) {
    console.log(`\n  ${prefix}Created files:`);
    for (const file of result.filesCreated) {
      console.log(`    + ${file}`);
    }
  }

  if (result.keysAdded.length > 0) {
    console.log(`\n  ${prefix}Added keys:`);
    for (const { file, count } of result.keysAdded) {
      console.log(`    ${file}: +${count} keys`);
    }
  }

  if (result.filesCreated.length === 0 && result.keysAdded.length === 0) {
    console.log(`\n  Nothing to fix - all translations complete!`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const fix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');
  const langArg = args.find((arg) => arg.startsWith('--lang='));
  const specificLang = langArg?.split('=')[1];

  // Validate --lang argument
  if (specificLang && !fix) {
    if (!languageExists(specificLang)) {
      console.error(`\x1b[31mError: Language '${specificLang}' not found\x1b[0m`);
      console.error(`Available languages: ${getLanguages().join(', ')}`);
      process.exit(1);
    }
  }

  const languages = specificLang ? [specificLang] : getLanguages();

  if (languages.length === 0) {
    console.log('No target languages found to check.');
    process.exit(0);
  }

  if (fix) {
    const modeLabel = dryRun ? 'Previewing fixes' : 'Fixing translations';
    console.log(`${modeLabel} using base language: ${BASE_LANG}`);
    console.log(`Languages to fix: ${languages.join(', ')}`);
    if (dryRun) {
      console.log('\x1b[33mDry run mode - no files will be modified\x1b[0m');
    }

    let totalFixed = 0;

    for (const lang of languages) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`Language: ${lang}`);
      console.log('='.repeat(50));

      const result = fixLanguage(lang, dryRun);
      printFixResult(lang, result, dryRun);

      totalFixed +=
        result.filesCreated.length + result.keysAdded.reduce((sum, { count }) => sum + count, 0);
    }

    console.log(`\n${'='.repeat(50)}`);
    if (totalFixed > 0) {
      if (dryRun) {
        console.log(`\x1b[33mWould fix ${totalFixed} missing translation(s)\x1b[0m`);
        console.log(`Run without --dry-run to apply changes`);
      } else {
        console.log(`\x1b[32mFixed ${totalFixed} missing translation(s)\x1b[0m`);
      }
    } else {
      console.log(`\x1b[32mAll translations were already complete!\x1b[0m`);
    }
    process.exit(0);
  }

  // Check mode (default)
  console.log(`Checking translations against base language: ${BASE_LANG}`);
  console.log(`Languages to check: ${languages.join(', ')}`);
  if (strict) {
    console.log('Strict mode: also checking for extra keys');
  }

  let hasAnyIssues = false;
  const summary: { lang: string; missing: number; extra: number }[] = [];

  for (const lang of languages) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Language: ${lang}`);
    console.log('='.repeat(50));

    const result = checkLanguage(lang, strict);
    const hasIssues = printResult(lang, result);

    const missingCount =
      result.missingFiles.length +
      result.missingKeys.reduce((sum, { keys }) => sum + keys.length, 0);
    const extraCount = result.extraKeys.reduce((sum, { keys }) => sum + keys.length, 0);

    summary.push({ lang, missing: missingCount, extra: extraCount });

    if (hasIssues) {
      hasAnyIssues = true;
    } else {
      console.log('\n  All translations complete!');
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('Summary');
  console.log('='.repeat(50));

  for (const { lang, missing, extra } of summary) {
    const status = missing === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    let line = `${status} ${lang}: ${missing} missing`;
    if (strict && extra > 0) {
      line += `, ${extra} extra`;
    }
    console.log(line);
  }

  const totalMissing = summary.reduce((sum, { missing }) => sum + missing, 0);

  if (totalMissing > 0) {
    console.log(`\n\x1b[31mFound ${totalMissing} missing translation(s)\x1b[0m`);
    console.log(`\x1b[33mRun with --fix to add English defaults (use --dry-run to preview)\x1b[0m`);
    process.exit(1);
  } else {
    console.log(`\n\x1b[32mAll translations complete!\x1b[0m`);
    process.exit(0);
  }
}

main();
