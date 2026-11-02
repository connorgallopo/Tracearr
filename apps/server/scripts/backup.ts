#!/usr/bin/env tsx
/**
 * Tracearr Backup Script
 *
 * Creates a full database backup as a zip file containing metadata.json
 * and database.dump (pg_dump custom format).
 *
 * Usage:
 *   docker exec tracearr node apps/server/scripts/backup.ts
 *   docker exec tracearr node apps/server/scripts/backup.ts --json
 *
 * Local development (via pnpm):
 *   pnpm backup
 */

import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { resolve } from 'path';

// Load environment variables if DATABASE_URL is not already set
if (!process.env.DATABASE_URL) {
  const envPaths = [
    resolve(import.meta.dirname, '../../../.env'), // docker and dev
    '/data/tracearr/.env', // proxmox lxc
  ];

  let loaded = false;
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
      if (process.env.DATABASE_URL) {
        loaded = true;
        break;
      }
    }
  }

  if (!loaded) {
    console.error('ERROR: DATABASE_URL environment variable not found.\n');
    console.error('Tried loading from:');
    for (const path of envPaths) {
      console.error(`  • ${path}`);
    }
    console.error('\nPlease ensure DATABASE_URL is set or one of these files exists.\n');
    process.exit(1);
  }
}

// Determine if we're in development (src files) or production (dist files)
const srcPath = resolve(import.meta.dirname, '../src/services/backup.ts');
const useSrc = existsSync(srcPath);
const basePath = useSrc ? '../src' : '../dist';

const { BACKUP_DIR, createBackup } = await import(`${basePath}/services/backup.js`);

const jsonMode = process.argv.includes('--json');

async function main() {
  if (!jsonMode) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  Tracearr Backup');
    console.log('═══════════════════════════════════════════════════\n');
    console.log(`Output directory: ${BACKUP_DIR}`);
    console.log('Creating backup...\n');
  }

  try {
    const { filePath, metadata } = await createBackup(BACKUP_DIR, 'manual');
    const fileStat = await stat(filePath);

    if (jsonMode) {
      console.log(JSON.stringify({ filePath, size: fileStat.size, metadata }));
    } else {
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(2);
      const dbSizeMB = (metadata.database.databaseSize / 1024 / 1024).toFixed(2);
      console.log('Backup created successfully!\n');
      console.log(`  File:              ${filePath}`);
      console.log(`  Size:              ${sizeMB} MB`);
      console.log(`  Created:           ${metadata.createdAt}`);
      console.log(`  Version:           ${metadata.app.version} (${metadata.app.commit})`);
      console.log(
        `  Migrations:        ${metadata.database.migrationCount} (latest: ${metadata.database.latestMigration})`
      );
      console.log(`  Tables:            ${metadata.database.tableCount}`);
      console.log(`  Database size:     ${dbSizeMB} MB`);
      console.log(`  TimescaleDB:       ${metadata.database.timescaleVersion}`);
      if (metadata.database.timescaleToolkitVersion) {
        console.log(`  Timescale Toolkit: ${metadata.database.timescaleToolkitVersion}`);
      }
      console.log(`  Sessions:          ${metadata.counts.sessions}`);
      console.log(`  Users:             ${metadata.counts.users}`);
      console.log(`  Servers:           ${metadata.counts.servers}`);
      console.log(`  Rules:             ${metadata.counts.rules}`);
      console.log(`  Library items:     ${metadata.counts.libraryItems}`);
      console.log('');
    }
    process.exit(0);
  } catch (error) {
    if (jsonMode) {
      console.error(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
      );
    } else {
      console.error('\nERROR: Backup failed:\n');
      if (error instanceof Error) {
        console.error(`  ${error.message}\n`);
        if (process.env.DEBUG) {
          console.error('Stack trace:');
          console.error(error.stack);
        }
      } else {
        console.error('  Unknown error occurred');
      }
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
