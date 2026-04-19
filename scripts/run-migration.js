// backend/scripts/run-migration.js
// Script to run specific migration files against the configured Postgres database.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../db');

function hasDbConfig() {
  if (process.env.DATABASE_URL) return true;
  const needed = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
  return needed.every((k) => typeof process.env[k] === 'string' && process.env[k].length > 0);
}

async function runMigration(migrationFile) {
  try {
    if (!hasDbConfig()) {
      console.error('\nERROR: Nenhuma configuração de banco encontrada. Configure `DATABASE_URL` ou as variáveis PGHOST/PGUSER/PGPASSWORD/PGDATABASE antes de rodar este script.\n');
      console.error('Exemplo (PowerShell):');
      console.error("$env:DATABASE_URL = 'postgres://user:password@host:5432/dbname'");
      console.error("node scripts/run-migration.js migration_file.sql\n");
      process.exit(2);
    }

    const migrationPath = path.join(__dirname, '..', 'migrations', migrationFile);
    if (!fs.existsSync(migrationPath)) {
      console.error('Migration file not found at', migrationPath);
      process.exit(1);
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    console.log(`Applying migration: ${migrationFile}...`);
    await db.query(sql);
    console.log(`Migration ${migrationFile} applied successfully.`);
    return true;
  } catch (err) {
    console.error(`Failed to apply migration ${migrationFile}:`, err && err.message ? err.message : err);
    throw err;
  }
}

async function main() {
  const migrationFile = process.argv[2];
  
  if (!migrationFile) {
    console.error('Usage: node scripts/run-migration.js <migration-file.sql>');
    process.exit(1);
  }

  try {
    await runMigration(migrationFile);
    process.exit(0);
  } catch (err) {
    process.exit(1);
  }
}

// If called directly
if (require.main === module) {
  main();
}

module.exports = { runMigration };