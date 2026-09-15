import { z } from 'zod';
import { getBaseVersion, isPrerelease, normalizeVersion, parseVersion } from './releaseVersion.js';

export const RELEASE_CHANGE_TYPES = ['new', 'improved', 'fix', 'security', 'note'] as const;
export type ReleaseChangeType = (typeof RELEASE_CHANGE_TYPES)[number];

/** Stored in whatsNewLastSeenVersion for an install that predates the dialog. */
export const WHATS_NEW_LEGACY = 'legacy';

const DOCS_PREFIX = 'https://docs.tracearr.com/';
const RELEASES_TAG_URL = 'https://github.com/connorgallopo/Tracearr/releases/tag';

const docsUrl = z.string().startsWith(DOCS_PREFIX);

export const releaseChangeSchema = z.strictObject({
  type: z.enum(RELEASE_CHANGE_TYPES),
  text: z
    .string()
    .min(1)
    .max(120)
    .refine((text) => !text.includes('\n'), 'one line')
    .refine((text) => !text.endsWith('.'), 'no trailing period'),
  refs: z
    .array(z.string().regex(/^#\d+$/))
    .max(3)
    .optional(),
  docs: docsUrl.optional(),
});
export type ReleaseChange = z.infer<typeof releaseChangeSchema>;

export const releaseHighlightSchema = z.strictObject({
  title: z.string().min(1).max(40),
  body: z.string().min(1).max(400),
  docs: docsUrl.optional(),
});
export type ReleaseHighlight = z.infer<typeof releaseHighlightSchema>;

export function isMinorRelease(version: string): boolean {
  const parsed = parseVersion(version);
  return !parsed.isPrerelease && parsed.patch === 0 && parsed.major + parsed.minor > 0;
}

export const releaseNotesFileSchema = z
  .strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    headline: z.string().min(1).max(80).optional(),
    upgradeWarning: z.string().min(1).max(160).optional(),
    highlights: z.array(releaseHighlightSchema).min(1).max(4).optional(),
    changes: z.array(releaseChangeSchema).min(1),
  })
  .superRefine((file, ctx) => {
    if (parseVersion(file.version).patch > 0) {
      if (file.headline) {
        ctx.addIssue({
          code: 'custom',
          path: ['headline'],
          message: 'only an x.y.0 file has a headline',
        });
      }
      if (file.highlights) {
        ctx.addIssue({
          code: 'custom',
          path: ['highlights'],
          message: 'only an x.y.0 file has highlights',
        });
      }
    }
  });
export type ReleaseNotesFile = z.infer<typeof releaseNotesFileSchema>;

/** Human-readable problems tagging `tag` with `file` would cause; empty when clean. */
export function releaseTagIssues(file: ReleaseNotesFile, tag: string): string[] {
  const issues: string[] = [];
  const base = getBaseVersion(normalizeVersion(tag));
  if (base !== file.version) {
    issues.push(`release-notes/${base}.json says version ${file.version}`);
    return issues;
  }
  if (!isPrerelease(tag) && isMinorRelease(file.version)) {
    if (!file.headline) issues.push(`tagging v${file.version} needs a headline`);
    if (!file.highlights) issues.push(`tagging v${file.version} needs 1 to 4 highlights`);
  }
  return issues;
}

export interface WhatsNewState {
  runningVersion: string;
  lastSeenVersion: string | null;
}

export interface UpgradeWarning {
  version: string;
  text: string;
}

const SECTION_TITLES: Record<ReleaseChangeType, string> = {
  new: 'New',
  improved: 'Improved',
  fix: 'Fixes',
  security: 'Security',
  note: 'Notes',
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderChange(change: ReleaseChange): string {
  let line = `- ${capitalize(change.text)}`;
  if (change.refs?.length) line += ` (${change.refs.join(', ')})`;
  if (change.docs) line += ` ([docs](${change.docs}))`;
  return line;
}

export function renderReleaseNotesMarkdown(file: ReleaseNotesFile, tag?: string): string {
  const titleVersion = tag ? normalizeVersion(tag) : file.version;
  const lines = [
    file.headline
      ? `# Tracearr v${titleVersion} - ${file.headline}`
      : `# Tracearr v${titleVersion}`,
  ];
  if (file.upgradeWarning) lines.push('', `**${file.upgradeWarning}**`);
  for (const highlight of file.highlights ?? []) {
    lines.push(
      '',
      `### ${highlight.title}`,
      highlight.docs ? `${highlight.body} [Docs](${highlight.docs})` : highlight.body
    );
  }
  for (const type of RELEASE_CHANGE_TYPES) {
    const changes = file.changes.filter((change) => change.type === type);
    if (changes.length > 0)
      lines.push('', `### ${SECTION_TITLES[type]}`, ...changes.map(renderChange));
  }
  const parsed = parseVersion(titleVersion);
  if (!parsed.isPrerelease && parsed.patch > 0) {
    lines.push('', `Other release notes: ${RELEASES_TAG_URL}/v${parsed.major}.${parsed.minor}.0`);
  }
  return `${lines.join('\n')}\n`;
}
