#!/usr/bin/env node
/**
 * Setup Calendars Script
 *
 * Creates Google Calendar for each Tom unit and configures permissions.
 *
 * For each unit (id_empresa = 1, ativo = true):
 * 1. Creates a calendar owned by recrutamento@tomeducacao.com.br
 *    - Name: nome_unidade
 * 2. Updates rh_sistema_prod.unidade.agenda_url with the new calendar ID
 * 3. Grants 'writer' permission to email_unidade_contato via ACL
 * 4. Adds calendar to email_unidade_contato's list with summaryOverride "Aula-Teste / Entrevista"
 *
 * Usage:
 *   node scripts/setup-calendars.js              # Dry run (no changes)
 *   node scripts/setup-calendars.js --execute    # Actually execute
 *   node scripts/setup-calendars.js --single 159 # Process single unit by ID
 */

require('dotenv').config();
const { Pool } = require('pg');
const googleCalendar = require('../src/lib/googleCalendar');

// Configuration
const OWNER_EMAIL = 'recrutamento@tomeducacao.com.br';
const SUMMARY_OVERRIDE = 'Aula-Teste / Entrevista';
const RH_SCHEMA = 'rh_sistema_prod';

// Parse arguments
const args = process.argv.slice(2);
const executeMode = args.includes('--execute');
const singleUnitArg = args.find(a => a.startsWith('--single'));
const singleUnitId = singleUnitArg ? parseInt(args[args.indexOf('--single') + 1] || args[args.indexOf(singleUnitArg) + 1]) : null;

// Database connection (direct to RH schema for updates)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

/**
 * Fetch all Tom units (id_empresa = 1)
 */
async function fetchUnits(singleId = null) {
  let query = `
    SELECT id_unidade, nome_unidade, email_unidade_contato, agenda_url
    FROM ${RH_SCHEMA}.unidade
    WHERE id_empresa = 1 AND ativo = true
  `;
  const params = [];

  if (singleId) {
    query += ' AND id_unidade = $1';
    params.push(singleId);
  }

  query += ' ORDER BY nome_unidade';

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Update agenda_url in the base table
 */
async function updateAgendaUrl(idUnidade, calendarId) {
  const query = `
    UPDATE ${RH_SCHEMA}.unidade
    SET agenda_url = $1
    WHERE id_unidade = $2
  `;
  await pool.query(query, [calendarId, idUnidade]);
}

/**
 * Process a single unit
 */
async function processUnit(unit, dryRun = true) {
  const { id_unidade, nome_unidade, email_unidade_contato, agenda_url } = unit;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Unit: ${nome_unidade} (ID: ${id_unidade})`);
  console.log(`Email Contato: ${email_unidade_contato}`);
  console.log(`Current agenda_url: ${agenda_url || '(none)'}`);
  console.log(`${'='.repeat(60)}`);

  if (!email_unidade_contato) {
    console.log('⚠️  SKIP: No email_unidade_contato defined');
    return { success: false, reason: 'no_email' };
  }

  if (dryRun) {
    console.log('🔍 DRY RUN - Would execute:');
    console.log(`   1. createCalendar(${OWNER_EMAIL}, "${nome_unidade}")`);
    console.log(`   2. UPDATE unidade SET agenda_url = <new_id> WHERE id_unidade = ${id_unidade}`);
    console.log(`   3. insertAcl(${OWNER_EMAIL}, <new_id>, ${email_unidade_contato}, "writer")`);
    console.log(`   4. insertCalendarList(${email_unidade_contato}, <new_id>, "${SUMMARY_OVERRIDE}")`);
    return { success: true, dryRun: true };
  }

  try {
    // Step 1: Create calendar (owned by recrutamento@)
    console.log(`\n📅 Creating calendar "${nome_unidade}"...`);
    const newCalendar = await googleCalendar.createCalendar(OWNER_EMAIL, nome_unidade, {
      description: `Calendário de Aula-Teste para ${nome_unidade}`,
    });
    const calendarId = newCalendar.id;
    console.log(`   ✅ Created: ${calendarId}`);

    // Step 2: Update database
    console.log(`\n💾 Updating database...`);
    await updateAgendaUrl(id_unidade, calendarId);
    console.log(`   ✅ agenda_url updated`);

    // Step 3: Grant writer permission to email_unidade_contato
    console.log(`\n🔐 Granting writer permission to ${email_unidade_contato}...`);
    await googleCalendar.insertAcl(OWNER_EMAIL, calendarId, email_unidade_contato, 'writer');
    console.log(`   ✅ ACL created`);

    // Step 4: Add to email_unidade_contato's calendar list with summaryOverride
    console.log(`\n📋 Adding to ${email_unidade_contato}'s calendar list...`);
    await googleCalendar.insertCalendarList(email_unidade_contato, calendarId, SUMMARY_OVERRIDE);
    console.log(`   ✅ CalendarList entry created as "${SUMMARY_OVERRIDE}"`);

    return { success: true, calendarId };

  } catch (error) {
    console.error(`\n❌ ERROR: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  SETUP CALENDARS SCRIPT');
  console.log('═'.repeat(70));
  console.log(`Mode: ${executeMode ? '🚀 EXECUTE' : '🔍 DRY RUN'}`);
  console.log(`Owner: ${OWNER_EMAIL}`);
  console.log(`SummaryOverride: ${SUMMARY_OVERRIDE}`);
  if (singleUnitId) {
    console.log(`Single Unit: ${singleUnitId}`);
  }
  console.log('═'.repeat(70));

  try {
    // Fetch units
    const units = await fetchUnits(singleUnitId);
    console.log(`\nFound ${units.length} unit(s) to process`);

    if (units.length === 0) {
      console.log('No units found. Exiting.');
      return;
    }

    // Process each unit
    const results = { success: 0, skipped: 0, failed: 0 };

    for (const unit of units) {
      const result = await processUnit(unit, !executeMode);

      if (result.success) {
        if (result.dryRun) {
          results.success++;
        } else {
          results.success++;
        }
      } else if (result.reason === 'no_email') {
        results.skipped++;
      } else {
        results.failed++;
      }

      // Rate limiting: wait 1 second between units to avoid API throttling
      if (executeMode && units.indexOf(unit) < units.length - 1) {
        console.log('\n⏳ Waiting 1s before next unit...');
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('  SUMMARY');
    console.log('═'.repeat(70));
    console.log(`Total units: ${units.length}`);
    console.log(`✅ Success: ${results.success}`);
    console.log(`⚠️  Skipped: ${results.skipped}`);
    console.log(`❌ Failed: ${results.failed}`);

    if (!executeMode) {
      console.log('\n📝 This was a DRY RUN. To execute, run with --execute flag:');
      console.log('   node scripts/setup-calendars.js --execute');
    }

  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
