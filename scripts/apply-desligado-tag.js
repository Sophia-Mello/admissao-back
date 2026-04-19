#!/usr/bin/env node
/**
 * Apply Desligado Tag Script
 *
 * Reads CPFs from a CSV file and applies the "desligado" tag to all
 * matching applications via the Gupy API.
 *
 * Usage:
 *   node scripts/apply-desligado-tag.js                    # Dry run (no changes)
 *   node scripts/apply-desligado-tag.js --execute          # Actually execute
 *   node scripts/apply-desligado-tag.js --file path.csv    # Custom CSV file
 *
 * CSV Format:
 *   CPF
 *   025.950.309-65
 *   155.209.059-08
 *   ...
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const gupyService = require('../src/services/gupyService');

// Configuration
const TAG_NAME = 'desligado';
const DEFAULT_CSV_PATH = path.join(__dirname, '../../docs/desligados.csv');
const SCHEMA = process.env.DB_SCHEMA || 'rs_admissao_prod';

// Parse arguments
const args = process.argv.slice(2);
const executeMode = args.includes('--execute');
const fileArgIndex = args.indexOf('--file');
const csvPath = fileArgIndex !== -1 ? args[fileArgIndex + 1] : DEFAULT_CSV_PATH;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

/**
 * Read and parse CPFs from CSV file
 */
function readCPFsFromCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  // Skip header
  const cpfs = lines.slice(1)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(cpf => cpf.replace(/[.\-]/g, '')); // Remove formatting

  return cpfs;
}

/**
 * Fetch applications matching the given CPFs
 */
async function fetchApplications(cpfs) {
  // Use ANY with array for better performance with large lists
  const query = `
    SELECT
      a.id,
      a.id_application_gupy,
      js.id_job_gupy,
      c.cpf,
      c.nome,
      a.current_step_name,
      a.tags
    FROM ${SCHEMA}.application a
    JOIN ${SCHEMA}.candidate c ON c.id = a.id_candidate
    JOIN ${SCHEMA}.job_subregional js ON js.id_job_subregional = a.id_job_subregional
    WHERE c.cpf = ANY($1::text[])
    ORDER BY c.nome
  `;

  const result = await pool.query(query, [cpfs]);
  return result.rows;
}

/**
 * Apply tag to a single application via Gupy API
 */
async function applyTag(application) {
  const { id_job_gupy, id_application_gupy, nome, cpf } = application;

  try {
    await gupyService.addTag(id_job_gupy, id_application_gupy, TAG_NAME);
    console.log(`  ✓ Tag applied: ${nome} (CPF: ${cpf})`);
    return { success: true, application };
  } catch (error) {
    console.error(`  ✗ Failed: ${nome} (CPF: ${cpf}) - ${error.message}`);
    return { success: false, application, error: error.message };
  }
}

/**
 * Update local database tags
 */
async function updateLocalTags(applicationId, currentTags) {
  const tags = currentTags || [];
  if (!tags.includes(TAG_NAME)) {
    tags.push(TAG_NAME);
  }

  await pool.query(
    `UPDATE ${SCHEMA}.application SET tags = $1 WHERE id = $2`,
    [JSON.stringify(tags), applicationId]
  );
}

/**
 * Main execution
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Apply Desligado Tag Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${executeMode ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`CSV File: ${csvPath}`);
  console.log(`Tag: ${TAG_NAME}`);
  console.log(`Schema: ${SCHEMA}`);
  console.log('='.repeat(60));

  // Read CPFs
  console.log('\n[1/4] Reading CPFs from CSV...');
  const cpfs = readCPFsFromCSV(csvPath);
  console.log(`  Found ${cpfs.length} CPFs in file`);

  // Fetch applications
  console.log('\n[2/4] Fetching applications from database...');
  const applications = await fetchApplications(cpfs);
  console.log(`  Found ${applications.length} applications matching CPFs`);

  if (applications.length === 0) {
    console.log('\nNo applications to process. Exiting.');
    await pool.end();
    return;
  }

  // Show preview
  console.log('\n[3/4] Applications to tag:');
  console.log('-'.repeat(60));
  applications.forEach((app, i) => {
    const hasTag = app.tags && app.tags.includes(TAG_NAME);
    const status = hasTag ? '[already tagged]' : '[will tag]';
    console.log(`  ${i + 1}. ${app.nome} (CPF: ${app.cpf}) ${status}`);
    console.log(`     Step: ${app.current_step_name}`);
    console.log(`     Gupy: job=${app.id_job_gupy}, app=${app.id_application_gupy}`);
  });
  console.log('-'.repeat(60));

  // Filter applications that don't have the tag yet
  const toTag = applications.filter(app => !app.tags || !app.tags.includes(TAG_NAME));
  console.log(`\n  ${toTag.length} applications need tagging`);
  console.log(`  ${applications.length - toTag.length} already have the tag`);

  if (!executeMode) {
    console.log('\n[4/4] DRY RUN - No changes made');
    console.log('  Run with --execute to apply tags');
    await pool.end();
    return;
  }

  // Apply tags
  console.log('\n[4/4] Applying tags via Gupy API...');
  const results = { success: 0, failed: 0, errors: [] };

  for (const app of toTag) {
    const result = await applyTag(app);
    if (result.success) {
      results.success++;
      // Update local database too
      await updateLocalTags(app.id, app.tags);
    } else {
      results.failed++;
      results.errors.push(result);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Total applications: ${applications.length}`);
  console.log(`  Already tagged: ${applications.length - toTag.length}`);
  console.log(`  Successfully tagged: ${results.success}`);
  console.log(`  Failed: ${results.failed}`);

  if (results.errors.length > 0) {
    console.log('\nFailed applications:');
    results.errors.forEach(({ application, error }) => {
      console.log(`  - ${application.nome} (${application.cpf}): ${error}`);
    });
  }

  await pool.end();
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
