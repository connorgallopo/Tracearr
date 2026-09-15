/**
 * Core backup and restore logic for Tracearr.
 *
 * Shared by CLI scripts, API routes, and the scheduled backup worker.
 * Handles pg_dump/pg_restore, zip creation/validation, Redis purge,
 * Tailscale state cleanup, and backup retention management.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, unlinkSync, rmSync } from 'node:fs';
import {
  access,
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
  stat,
  rename,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { ZipArchive } from 'archiver';
import { Open } from 'unzipper';
import {
  compareVersions,
  type BackupListItem,
  type BackupMetadata,
  type BackupType,
} from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users, servers, automations, libraryItems } from '../db/schema.js';

import { getCurrentVersion, getCurrentCommit, getCurrentTag } from '../jobs/versionCheckQueue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backup';

/** Ensure BACKUP_DIR exists and is writable. */
async function ensureBackupDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new Error(
      `Backup directory "${dir}" is not writable. Check file permissions or set BACKUP_DIR to a writable path.`
    );
  }
}

/** Create a temp directory inside BACKUP_DIR to avoid cross-device rename issues with bind mounts. */
async function backupTempDir(prefix: string): Promise<string> {
  const tmpBase = join(BACKUP_DIR, 'tmp');
  await mkdir(tmpBase, { recursive: true });
  return mkdtemp(join(tmpBase, prefix));
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn a child process and capture output. */
function execCommand(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));

    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

/** Parse DATABASE_URL into pg connection env vars. */
function parseDatabaseUrl(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1), // remove leading /
  };
}

/** Format a date as YYYYMMDD-HHmmss. */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Version safety check
// ---------------------------------------------------------------------------

/**
 * Compare pg_dump client version against the server version.
 * Aborts if client major < server major (backup would be incomplete).
 */
async function checkPgVersionCompatibility(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const pgEnv = parseDatabaseUrl(databaseUrl);

  // Get client version
  const client = await execCommand('pg_dump', ['--version']);
  if (client.exitCode !== 0) {
    throw new Error(`pg_dump not found: ${client.stderr}`);
  }
  const clientMatch = client.stdout.match(/(\d+)\./);
  const clientMajor = clientMatch?.[1] ? parseInt(clientMatch[1], 10) : 0;

  // Get server version
  const server = await execCommand('psql', ['-t', '-A', '-c', 'SHOW server_version;'], pgEnv);
  if (server.exitCode !== 0) {
    throw new Error(`Could not query server version: ${server.stderr}`);
  }
  const serverMatch = server.stdout.trim().match(/^(\d+)/);
  const serverMajor = serverMatch?.[1] ? parseInt(serverMatch[1], 10) : 0;

  if (clientMajor < serverMajor) {
    throw new Error(
      `pg_dump version ${clientMajor} is older than PostgreSQL server version ${serverMajor}. ` +
        `Backup may be incomplete. Update the PostgreSQL client tools to version ${serverMajor}+.`
    );
  }
}

// ---------------------------------------------------------------------------
// Create backup
// ---------------------------------------------------------------------------

export async function createBackup(
  outputDir: string = BACKUP_DIR,
  type: BackupType = 'manual'
): Promise<{ filePath: string; metadata: BackupMetadata }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  await ensureBackupDir(outputDir);
  await checkPgVersionCompatibility();

  const pgEnv = parseDatabaseUrl(databaseUrl);
  const tempDir = await backupTempDir('tracearr-backup-');

  try {
    // 1. Run pg_dump -Fc (custom format)
    const dumpPath = join(tempDir, 'database.dump');
    const dump = await execCommand('pg_dump', ['-Fc', '-f', dumpPath], pgEnv);
    if (dump.exitCode !== 0) {
      throw new Error(`pg_dump failed: ${dump.stderr}`);
    }

    // 2. Build metadata
    const metadata = await buildMetadata(pgEnv);

    // 3. Write metadata.json to temp dir
    const metadataPath = join(tempDir, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // 4. Create zip
    const timestamp = formatTimestamp(new Date());
    const zipFilename = `tracearr-backup-${timestamp}.zip`;
    const zipPath = join(tempDir, zipFilename);

    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(zipPath);
      const archive = new ZipArchive({ zlib: { level: 1 } });

      output.on('close', () => resolvePromise());
      archive.on('error', reject);

      archive.pipe(output);
      archive.file(metadataPath, { name: 'metadata.json' });
      archive.file(dumpPath, { name: 'database.dump' });
      void archive.finalize();
    });

    // 5. Move zip to output dir
    const finalZipPath = join(outputDir, zipFilename);
    await rename(zipPath, finalZipPath);

    // 6. Write sidecar metadata
    const zipStat = await stat(finalZipPath);
    const sidecar: BackupListItem = {
      filename: zipFilename,
      size: zipStat.size,
      createdAt: metadata.createdAt,
      type,
      metadata,
    };
    const sidecarPath = join(outputDir, zipFilename.replace('.zip', '.meta.json'));
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));

    return { filePath: finalZipPath, metadata };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function getPgServerVersion(pgEnv: Record<string, string>): Promise<string> {
  const result = await execCommand('psql', ['-t', '-A', '-c', 'SHOW server_version;'], pgEnv);
  if (result.exitCode !== 0) {
    throw new Error(`Could not query server version: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function buildMetadata(pgEnv: Record<string, string>): Promise<BackupMetadata> {
  const readMigrationJournal = async (journalPaths: string[]) => {
    let count = 0;
    let latest = 'unknown';

    for (const p of journalPaths) {
      if (existsSync(p)) {
        const journal = JSON.parse(await readFile(p, 'utf-8')) as {
          entries: { idx: number; tag: string }[];
        };
        count = journal.entries.length;
        const last = journal.entries[journal.entries.length - 1];
        if (last) latest = last.tag;
        break;
      }
    }

    return { count, latest };
  };

  const upstreamMigrations = await readMigrationJournal([
    resolve(__dirname, '../../src/db/migrations/meta/_journal.json'),
    resolve(__dirname, '../src/db/migrations/meta/_journal.json'),
  ]);
  const forkMigrations = await readMigrationJournal([
    resolve(__dirname, '../../src/db/fork-migrations/meta/_journal.json'),
    resolve(__dirname, '../src/db/fork-migrations/meta/_journal.json'),
  ]);

  const migrationCount = upstreamMigrations.count;
  const latestMigration = upstreamMigrations.latest;
  const forkMigrationCount = forkMigrations.count;
  const latestForkMigration = forkMigrations.latest;

  // Query table count and extension versions
  const tableCountResult = await execCommand(
    'psql',
    [
      '-t',
      '-A',
      '-c',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';",
    ],
    pgEnv
  );
  const tableCount = parseInt(tableCountResult.stdout.trim(), 10) || 0;

  const tsVersionResult = await execCommand(
    'psql',
    [
      '-t',
      '-A',
      '-c',
      "SELECT installed_version FROM pg_available_extensions WHERE name = 'timescaledb';",
    ],
    pgEnv
  );
  const timescaleVersion = tsVersionResult.stdout.trim() || 'unknown';

  const toolkitResult = await execCommand(
    'psql',
    [
      '-t',
      '-A',
      '-c',
      "SELECT installed_version FROM pg_available_extensions WHERE name = 'timescaledb_toolkit';",
    ],
    pgEnv
  );
  const toolkitVersion = toolkitResult.stdout.trim() || null;

  // Query database size and record counts
  const [dbSizeResult, sessionCount, userCount, serverCount, automationCount, libraryItemCount] =
    await Promise.all([
      db.execute<{ size: string }>(sql`SELECT pg_database_size(current_database()) AS size`),
      db.select({ count: sql<number>`count(*)::int` }).from(sessions),
      db.select({ count: sql<number>`count(*)::int` }).from(users),
      db.select({ count: sql<number>`count(*)::int` }).from(servers),
      db.select({ count: sql<number>`count(*)::int` }).from(automations),
      db.select({ count: sql<number>`count(*)::int` }).from(libraryItems),
    ]);
  const databaseSize = Number(dbSizeResult.rows[0]?.size ?? 0);

  const pgVersion = await getPgServerVersion(pgEnv);

  return {
    format: 1,
    createdAt: new Date().toISOString(),
    app: {
      version: getCurrentVersion(),
      commit: getCurrentCommit() ?? '',
      tag: getCurrentTag() ?? '',
    },
    database: {
      pgVersion,
      migrationCount,
      latestMigration,
      forkMigrationCount,
      latestForkMigration,
      tableCount,
      databaseSize,
      timescaleVersion,
      timescaleToolkitVersion: toolkitVersion,
    },
    counts: {
      sessions: sessionCount[0]?.count ?? 0,
      users: userCount[0]?.count ?? 0,
      servers: serverCount[0]?.count ?? 0,
      automations: automationCount[0]?.count ?? 0,
      libraryItems: libraryItemCount[0]?.count ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Validate backup
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  metadata: BackupMetadata | null;
  errors: string[];
}

const ALLOWED_ENTRIES = new Set(['metadata.json', 'database.dump']);
const MAX_UNCOMPRESSED_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB sanity limit

/**
 * Validate a backup zip file. Checks structure, entry names, sizes,
 * and metadata format without extracting to disk.
 */
/** Digit-splitting broke on v-prefixed and prerelease tags (v2.0.0-beta.1 read
 * as [NaN, 0, NaN]), so this must go through the real semver comparator. */
export function backupVersionIsNewer(backupVersion: string, currentVersion: string): boolean {
  return compareVersions(backupVersion, currentVersion) > 0;
}

export async function validateBackup(zipPath: string): Promise<ValidationResult> {
  const errors: string[] = [];

  if (!existsSync(zipPath)) {
    return { valid: false, metadata: null, errors: ['Backup file does not exist'] };
  }

  let directory;
  try {
    directory = await Open.file(zipPath);
  } catch {
    return { valid: false, metadata: null, errors: ['File is not a valid zip archive'] };
  }

  const entries = directory.files;

  // Check entry count
  if (entries.length !== 2) {
    errors.push(`Expected 2 entries (metadata.json, database.dump), found ${entries.length}`);
  }

  // Validate each entry
  let totalSize = 0;
  for (const entry of entries) {
    const name = entry.path;

    // Reject directory traversal, absolute paths, backslashes, directory components
    if (name.includes('..') || name.startsWith('/') || name.includes('\\') || name.includes('/')) {
      errors.push(`Unsafe entry name: ${name}`);
      continue;
    }

    if (!ALLOWED_ENTRIES.has(name)) {
      errors.push(`Unexpected entry: ${name}`);
    }

    totalSize += entry.uncompressedSize ?? 0;
  }

  // Zip bomb protection
  if (totalSize > MAX_UNCOMPRESSED_SIZE) {
    errors.push(`Total uncompressed size (${totalSize} bytes) exceeds 10 GB limit`);
  }

  if (errors.length > 0) {
    return { valid: false, metadata: null, errors };
  }

  // Extract and parse metadata.json (in memory only)
  const metadataEntry = entries.find((e) => e.path === 'metadata.json');
  if (!metadataEntry) {
    return { valid: false, metadata: null, errors: ['metadata.json not found in archive'] };
  }

  let metadata: BackupMetadata;
  try {
    const buf = await metadataEntry.buffer();
    metadata = JSON.parse(buf.toString('utf-8')) as BackupMetadata;
  } catch {
    return { valid: false, metadata: null, errors: ['Failed to parse metadata.json'] };
  }

  // Validate metadata format
  if (metadata.format !== 1) {
    errors.push(`Unknown backup format version: ${metadata.format}`);
  }

  if (!metadata.createdAt || !metadata.app || !metadata.database) {
    errors.push('Metadata is missing required fields');
  }

  // PG version check (soft gate): reject early if metadata includes pgVersion
  // and it's newer than the current server. checkDumpCompatibility() verifies
  // against the actual dump before restore as the authoritative check.
  if (metadata.database.pgVersion) {
    try {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        const pgEnv = parseDatabaseUrl(databaseUrl);
        const currentPgVersion = await getPgServerVersion(pgEnv);
        const backupPgMajor = parseInt(metadata.database.pgVersion.match(/^(\d+)/)?.[1] ?? '0', 10);
        const currentPgMajor = parseInt(currentPgVersion.match(/^(\d+)/)?.[1] ?? '0', 10);

        if (backupPgMajor > currentPgMajor) {
          errors.push(
            `Backup was created on PostgreSQL ${backupPgMajor} but this server runs PostgreSQL ${currentPgMajor}. ` +
              `Restoring a dump from a newer PostgreSQL version is not supported.`
          );
        }
      }
    } catch {
      // If we can't query the server version, checkDumpCompatibility() will catch it before restore
    }
  }

  // Version check: backup version must be <= current
  if (metadata.app?.version && backupVersionIsNewer(metadata.app.version, getCurrentVersion())) {
    errors.push(
      `Backup version ${metadata.app.version} is newer than current version ${getCurrentVersion()}. ` +
        `Update Tracearr before restoring this backup.`
    );
  }

  return {
    valid: errors.length === 0,
    metadata,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Extract dump from zip (safe extraction)
// ---------------------------------------------------------------------------

/**
 * Safely extract database.dump from a validated zip to a temp directory.
 * Returns the path to the extracted dump file and the temp dir (caller must clean up).
 */
export async function extractDump(zipPath: string): Promise<{ dumpPath: string; tempDir: string }> {
  const tempDir = await backupTempDir('tracearr-restore-');

  try {
    const directory = await Open.file(zipPath);
    const dumpEntry = directory.files.find((e) => e.path === 'database.dump');
    if (!dumpEntry) {
      throw new Error('database.dump not found in archive');
    }

    // Validate target path stays within temp dir
    const targetPath = resolve(tempDir, 'database.dump');
    if (!targetPath.startsWith(tempDir)) {
      throw new Error('Path traversal detected in extraction');
    }

    // Stream entry to disk
    await new Promise<void>((resolvePromise, reject) => {
      const stream = dumpEntry.stream();
      const out = createWriteStream(targetPath);
      stream.pipe(out);
      out.on('finish', () => resolvePromise());
      out.on('error', reject);
      stream.on('error', reject);
    });

    return { dumpPath: targetPath, tempDir };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pre-restore PG version check
// ---------------------------------------------------------------------------

/**
 * Read the PG version that created a dump using `pg_restore --list`.
 * The header contains a line like: `; Dumped from database version: 18.3`
 */
async function getDumpPgVersion(dumpPath: string): Promise<string | null> {
  const result = await execCommand('pg_restore', ['--list', dumpPath]);
  if (result.exitCode !== 0) return null;

  const match = result.stdout.match(/Dumped from database version: (.+)/);
  return match?.[1]?.trim() ?? null;
}

/**
 * Check that the dump's PG major version is compatible with the current server.
 * A dump from PG 18 cannot be restored into PG 15 — pg_restore will fail with
 * "unsupported version (X.XX) in file header".
 *
 * Call this after extractDump() and before restoreDatabase().
 */
export async function checkDumpCompatibility(dumpPath: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;

  const dumpVersion = await getDumpPgVersion(dumpPath);
  if (!dumpVersion) return;

  const pgEnv = parseDatabaseUrl(databaseUrl);
  const currentVersion = await getPgServerVersion(pgEnv);

  const dumpMajor = parseInt(dumpVersion.match(/^(\d+)/)?.[1] ?? '0', 10);
  const currentMajor = parseInt(currentVersion.match(/^(\d+)/)?.[1] ?? '0', 10);

  if (dumpMajor > currentMajor) {
    throw new Error(
      `Backup was created on PostgreSQL ${dumpMajor} but this server runs PostgreSQL ${currentMajor}. ` +
        `Restoring a dump from a newer PostgreSQL version is not supported.`
    );
  }
}

// ---------------------------------------------------------------------------
// Restore database
// ---------------------------------------------------------------------------

/**
 * Drop all objects in the database and restore from a pg_dump custom-format dump.
 *
 * Uses DROP EXTENSION CASCADE + DROP SCHEMA CASCADE approach
 * (no DROP DATABASE — works without CREATEDB privileges or maintenance DB access).
 *
 * TimescaleDB requires special handling: pre_restore/post_restore mode must wrap
 * pg_restore to suppress "ONLY option not supported on hypertable operations" errors.
 */
export async function restoreDatabase(
  dumpPath: string,
  backupTimescaleVersion?: string
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const pgEnv = parseDatabaseUrl(databaseUrl);

  // Step 1: Clean the database — drop extensions, all schemas, then recreate public
  const cleanupSql = `
    DROP EXTENSION IF EXISTS timescaledb_toolkit CASCADE;
    DROP EXTENSION IF EXISTS timescaledb CASCADE;
    DROP EXTENSION IF EXISTS pg_trgm CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO "${pgEnv.PGUSER}";
  `;

  const cleanup = await execCommand('psql', ['-c', cleanupSql], pgEnv);
  if (cleanup.exitCode !== 0) {
    throw new Error(`Database cleanup failed: ${cleanup.stderr}`);
  }

  // Step 2: Create TimescaleDB at the backup's version and enter pre-restore mode.
  // Creating at the matching version ensures pg_restore's catalog data is compatible.
  // pre_restore suppresses "ONLY option not supported on hypertable operations" errors.
  if (backupTimescaleVersion && !/^\d+\.\d+\.\d+$/.test(backupTimescaleVersion)) {
    throw new Error(`Invalid TimescaleDB version format: ${backupTimescaleVersion}`);
  }
  const versionClause = backupTimescaleVersion ? ` VERSION '${backupTimescaleVersion}'` : '';
  const preRestore = await execCommand(
    'psql',
    [
      '-c',
      `CREATE EXTENSION IF NOT EXISTS timescaledb${versionClause}; SELECT timescaledb_pre_restore();`,
    ],
    pgEnv
  );
  if (preRestore.exitCode !== 0) {
    throw new Error(`TimescaleDB pre-restore failed: ${preRestore.stderr}`);
  }

  // Step 3: Restore from dump
  // --single-transaction wraps the restore in BEGIN/COMMIT so it's all-or-nothing,
  // and implies --exit-on-error so pg_restore stops and exits non-zero on first failure.
  const restore = await execCommand(
    'pg_restore',
    ['--no-owner', '--no-acl', '--single-transaction', '-d', databaseUrl, dumpPath],
    pgEnv
  );

  if (restore.exitCode !== 0) {
    throw new Error(`pg_restore failed (exit code ${restore.exitCode}): ${restore.stderr.trim()}`);
  }

  // Step 4: Upgrade TimescaleDB to the installed version if the backup was older.
  // The extension was created at the backup's version in step 2, so this runs the
  // proper upgrade path (e.g. 2.24.0 → 2.25.0). No-op if versions already match.
  if (backupTimescaleVersion) {
    const updateExt = await execCommand(
      'psql',
      [
        '-c',
        `ALTER EXTENSION timescaledb UPDATE;
         DO $$ BEGIN ALTER EXTENSION timescaledb_toolkit UPDATE; EXCEPTION WHEN OTHERS THEN NULL; END $$;`,
      ],
      pgEnv
    );
    if (updateExt.exitCode !== 0) {
      const isAlreadyCurrent = updateExt.stderr.includes('already installed');
      if (!isAlreadyCurrent) {
        throw new Error(
          `TimescaleDB extension upgrade from ${backupTimescaleVersion} failed: ${updateExt.stderr}`
        );
      }
    }
  }

  // Step 5: Exit pre-restore mode — rebuilds TimescaleDB internal state
  const postRestore = await execCommand(
    'psql',
    ['-c', 'SELECT timescaledb_post_restore();'],
    pgEnv
  );
  if (postRestore.exitCode !== 0) {
    throw new Error(`TimescaleDB post-restore failed: ${postRestore.stderr}`);
  }

  // Step 6: Rebuild planner statistics so queries use indexes effectively
  // pg_dump does not include pg_statistic data, so without this the planner
  // has no row-count or distribution info and falls back to sequential scans.
  // Non-fatal: if ANALYZE fails the DB still works, just with suboptimal plans
  await execCommand('psql', ['-c', 'ANALYZE;'], pgEnv);
}

// ---------------------------------------------------------------------------
// Redis purge
// ---------------------------------------------------------------------------

/**
 * Flush all keys in the Redis database used by Tracearr.
 * Uses FLUSHDB (safe — Tracearr uses its own Redis DB index, not a shared keyspace).
 */
export async function purgeRedisKeys(): Promise<number> {
  const { Redis } = await import('ioredis');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is not set');

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const keyCount = await client.dbsize();
    await client.flushdb();
    return keyCount;
  } finally {
    client.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Tailscale state cleanup
// ---------------------------------------------------------------------------

/**
 * Remove Tailscale ephemeral state files so the restored DB's tailscale_state
 * takes precedence on next tailscaleService.initialize().
 */
export function cleanupTailscaleState(): void {
  const files = ['/tmp/ts-state', '/tmp/tailscaled.sock'];
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      // Ignore — file may not exist
    }
  }
  try {
    rmSync('/tmp/tailscale', { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Restore point
// ---------------------------------------------------------------------------

/**
 * Create a restore point before a restore — just pg_dump without full zip packaging.
 * Used for automatic rollback if the restore fails.
 */
export async function createRestorePoint(): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  await ensureBackupDir(BACKUP_DIR);
  const pgEnv = parseDatabaseUrl(databaseUrl);
  const timestamp = formatTimestamp(new Date());
  const dumpPath = join(BACKUP_DIR, `restore-point-${timestamp}.dump`);

  const result = await execCommand('pg_dump', ['-Fc', '-f', dumpPath], pgEnv);
  if (result.exitCode !== 0) {
    throw new Error(`Restore point creation failed: ${result.stderr}`);
  }

  return dumpPath;
}

// ---------------------------------------------------------------------------
// Backup retention management
// ---------------------------------------------------------------------------

/**
 * Remove old scheduled backups beyond the retention count.
 * Manual and uploaded backups are never auto-deleted.
 */
export async function cleanupOldBackups(retentionCount: number): Promise<number> {
  const files = await readdir(BACKUP_DIR);
  const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

  // Read sidecar metadata for each backup
  const scheduled: { filename: string; createdAt: string }[] = [];

  for (const metaFile of metaFiles) {
    try {
      const raw = await readFile(join(BACKUP_DIR, metaFile), 'utf-8');
      const item = JSON.parse(raw) as BackupListItem;
      if (item.type === 'scheduled') {
        scheduled.push({ filename: item.filename, createdAt: item.createdAt });
      }
    } catch {
      // Skip unreadable metadata
    }
  }

  // Sort newest first
  scheduled.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Delete beyond retention
  const toDelete = scheduled.slice(retentionCount);
  let deleted = 0;

  for (const item of toDelete) {
    try {
      const zipPath = join(BACKUP_DIR, item.filename);
      const metaPath = join(BACKUP_DIR, item.filename.replace('.zip', '.meta.json'));

      if (existsSync(zipPath)) unlinkSync(zipPath);
      if (existsSync(metaPath)) unlinkSync(metaPath);
      deleted++;
    } catch {
      // Continue with next
    }
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// List backups
// ---------------------------------------------------------------------------

/**
 * List all backups from BACKUP_DIR, reading sidecar metadata files.
 * Falls back to extracting metadata from zip if sidecar is missing.
 */
export async function listBackups(): Promise<BackupListItem[]> {
  if (!existsSync(BACKUP_DIR)) return [];

  const files = await readdir(BACKUP_DIR);
  const zipFiles = files.filter((f) => /^tracearr-backup-[\d-]+\.zip$/.test(f));

  const items: BackupListItem[] = [];

  for (const zipFile of zipFiles) {
    const metaFile = zipFile.replace('.zip', '.meta.json');
    const metaPath = join(BACKUP_DIR, metaFile);

    // Try sidecar first
    if (existsSync(metaPath)) {
      try {
        const raw = await readFile(metaPath, 'utf-8');
        items.push(JSON.parse(raw) as BackupListItem);
        continue;
      } catch {
        // Fall through to zip extraction
      }
    }

    // Fallback: extract metadata from zip
    try {
      const zipPath = join(BACKUP_DIR, zipFile);
      const directory = await Open.file(zipPath);
      const metadataEntry = directory.files.find((e) => e.path === 'metadata.json');
      if (!metadataEntry) continue;

      const buf = await metadataEntry.buffer();
      const metadata = JSON.parse(buf.toString('utf-8')) as BackupMetadata;
      const zipStat = await stat(zipPath);

      const item: BackupListItem = {
        filename: zipFile,
        size: zipStat.size,
        createdAt: metadata.createdAt,
        type: 'manual', // Default for backups without sidecar
        metadata,
      };

      items.push(item);

      // Write sidecar for future reads
      await writeFile(metaPath, JSON.stringify(item, null, 2));
    } catch {
      // Skip unreadable zips
    }
  }

  // Sort oldest first, newest last
  items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return items;
}
