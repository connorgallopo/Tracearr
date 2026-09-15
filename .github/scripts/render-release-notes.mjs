import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getBaseVersion,
  normalizeVersion,
  releaseNotesFileSchema,
  releaseTagIssues,
  renderReleaseNotesMarkdown,
} from '../../packages/shared/dist/index.js';

const { RELEASE_TAG: tag, RELEASE_NOTES_OUT_DIR: outDir } = process.env;
if (!tag) {
  console.error('RELEASE_TAG is required');
  process.exit(1);
}

const base = getBaseVersion(normalizeVersion(tag));
const path = `release-notes/${base}.json`;
if (!existsSync(path)) {
  console.error(`::error::Add entries to release-notes/${base}.json before tagging.`);
  process.exit(1);
}

const result = releaseNotesFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
if (!result.success) {
  console.error(`::error::${path} is invalid`);
  console.error(JSON.stringify(result.error.issues, null, 2));
  process.exit(1);
}

const issues = releaseTagIssues(result.data, tag);
if (issues.length > 0) {
  for (const issue of issues) console.error(`::error::${issue}`);
  process.exit(1);
}

const markdown = renderReleaseNotesMarkdown(result.data, tag);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'release_notes.md'), markdown);
  copyFileSync(path, join(outDir, 'release-notes.json'));
}
process.stdout.write(markdown);
