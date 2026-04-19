#!/usr/bin/env node
/**
 * Reset schema_migrations table to reflect current database state
 * This script marks all existing migrations as "applied" without running them
 *
 * Usage: DB_SCHEMA=rs_admissao_homolog node scripts/reset-migrations.js
 */

const db = require('../db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function resetMigrations() {
  const schema = process.env.DB_SCHEMA || 'rs_admissao_homolog';
  console.log(`\n🔄 Resetting migrations for schema: ${schema}\n`);

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW(),
        checksum VARCHAR(8)
      )
    `);

    // 2. Get list of all migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`📁 Found ${files.length} migration files\n`);

    // 3. Truncate existing records
    await client.query('TRUNCATE TABLE schema_migrations');
    console.log('🗑️  Cleared schema_migrations table\n');

    // 4. Insert all migrations as applied
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);

      await client.query(
        'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES ($1, NOW(), $2)',
        [file, checksum]
      );
      console.log(`  ✅ Marked as applied: ${file}`);
    }

    await client.query('COMMIT');
    console.log(`\n✨ Successfully reset ${files.length} migrations\n`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

resetMigrations();
