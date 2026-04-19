#!/usr/bin/env node
/**
 * Database Migration Runner with Tracking
 *
 * Features:
 * - Tracks applied migrations in schema_migrations table
 * - Applies pending migrations in order
 * - Supports dry-run mode
 * - Transaction-safe (rollback on error)
 *
 * Usage:
 *   node scripts/migrate.js                    # Apply all pending migrations
 *   node scripts/migrate.js --dry-run          # Show pending without applying
 *   node scripts/migrate.js --status           # Show migration status
 *   node scripts/migrate.js --force <file>     # Force run specific migration
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const TRACKING_TABLE = 'schema_migrations';

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

/**
 * Ensure the migration tracking table exists
 */
async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      checksum VARCHAR(64)
    )
  `);
}

/**
 * Get list of applied migrations from database
 */
async function getAppliedMigrations(client) {
  const { rows } = await client.query(
    `SELECT version, applied_at FROM ${TRACKING_TABLE} ORDER BY version`
  );
  return new Map(rows.map((r) => [r.version, r.applied_at]));
}

/**
 * Get list of migration files from filesystem
 */
function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Calculate simple checksum for migration file
 */
function getFileChecksum(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Apply a single migration
 */
async function applyMigration(client, filename, dryRun = false) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filePath, 'utf8');
  const checksum = getFileChecksum(filePath);

  if (dryRun) {
    log(`  [DRY-RUN] Would apply: ${filename}`, 'yellow');
    return;
  }

  log(`  → Applying: ${filename}...`, 'cyan');

  // Execute the migration SQL
  await client.query(sql);

  // Record in tracking table
  await client.query(
    `INSERT INTO ${TRACKING_TABLE} (version, checksum) VALUES ($1, $2)
     ON CONFLICT (version) DO UPDATE SET applied_at = NOW(), checksum = $2`,
    [filename, checksum]
  );

  log(`  ✓ Applied: ${filename}`, 'green');
}

/**
 * Show migration status
 */
async function showStatus() {
  const client = await db.getClient();

  try {
    await ensureTrackingTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();

    log(`\n=== Migration Status for ${db.currentSchema || 'default schema'} ===\n`, 'cyan');

    if (files.length === 0) {
      log('No migration files found in migrations/', 'yellow');
      return;
    }

    let pendingCount = 0;

    for (const file of files) {
      const appliedAt = applied.get(file);
      if (appliedAt) {
        const date = new Date(appliedAt).toISOString().slice(0, 19).replace('T', ' ');
        log(`  ✓ ${file} ${colors.dim}(applied ${date})${colors.reset}`, 'green');
      } else {
        log(`  ○ ${file} (pending)`, 'yellow');
        pendingCount++;
      }
    }

    log('');
    if (pendingCount > 0) {
      log(`${pendingCount} pending migration(s)`, 'yellow');
    } else {
      log('All migrations applied!', 'green');
    }
    log('');
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
async function runMigrations(dryRun = false) {
  const client = await db.getClient();

  try {
    await ensureTrackingTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();

    const pending = files.filter((f) => !applied.has(f));

    log(`\n=== Running Migrations on ${db.currentSchema || 'default schema'} ===\n`, 'cyan');

    if (pending.length === 0) {
      log('No pending migrations.', 'green');
      return 0;
    }

    log(`Found ${pending.length} pending migration(s):\n`);

    if (!dryRun) {
      await client.query('BEGIN');
    }

    try {
      for (const file of pending) {
        await applyMigration(client, file, dryRun);
      }

      if (!dryRun) {
        await client.query('COMMIT');
        log(`\n✓ Successfully applied ${pending.length} migration(s)`, 'green');
      } else {
        log(`\n[DRY-RUN] Would apply ${pending.length} migration(s)`, 'yellow');
      }

      return pending.length;
    } catch (err) {
      if (!dryRun) {
        await client.query('ROLLBACK');
        log(`\n✗ Migration failed, rolled back all changes`, 'red');
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Force run a specific migration (even if already applied)
 */
async function forceMigration(filename) {
  const client = await db.getClient();

  try {
    await ensureTrackingTable(client);

    log(`\n=== Force Running Migration on ${db.currentSchema || 'default schema'} ===\n`, 'cyan');
    log(`⚠ WARNING: Force-running migration bypasses tracking!`, 'yellow');

    await client.query('BEGIN');

    try {
      await applyMigration(client, filename, false);
      await client.query('COMMIT');
      log(`\n✓ Force-applied ${filename}`, 'green');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Check for required DB config
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    log('\n✗ ERROR: Database not configured!', 'red');
    log('  Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE\n', 'dim');
    process.exit(2);
  }

  try {
    if (args.includes('--status')) {
      await showStatus();
    } else if (args.includes('--dry-run')) {
      await runMigrations(true);
    } else if (args.includes('--force')) {
      const forceIndex = args.indexOf('--force');
      const filename = args[forceIndex + 1];
      if (!filename) {
        log('Usage: --force <migration-file.sql>', 'red');
        process.exit(1);
      }
      await forceMigration(filename);
    } else if (args.length === 0) {
      await runMigrations(false);
    } else {
      log(`Unknown argument: ${args[0]}`, 'red');
      log('\nUsage:', 'cyan');
      log('  node scripts/migrate.js              # Apply pending migrations');
      log('  node scripts/migrate.js --status     # Show migration status');
      log('  node scripts/migrate.js --dry-run    # Preview without applying');
      log('  node scripts/migrate.js --force <f>  # Force-run specific file');
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    log(`\n✗ Error: ${err.message}`, 'red');
    if (process.env.DEBUG) {
      console.error(err);
    }
    process.exit(1);
  }
}

main();
