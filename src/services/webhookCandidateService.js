const db = require('../../db');

// Gupy webhook sends snake_case status, but API v2 (and our DB) uses camelCase.
const WEBHOOK_STATUS_MAP = {
  in_process: 'inProgress',
  in_progress: 'inProgress',
};

function normalizeStatus(raw) {
  if (!raw) return null;
  return WEBHOOK_STATUS_MAP[raw] || raw;
}

/**
 * Shared UPSERT logic for webhook handlers.
 * Creates/updates candidate + application when the job exists locally.
 * Uses candidate data directly from the Gupy webhook payload (zero API calls).
 *
 * @param {Object} params
 * @param {string|number} params.jobGupyId - Gupy job ID from webhook payload
 * @param {string|number} params.applicationGupyId - Gupy application ID
 * @param {Object} params.candidateData - Raw candidate object from Gupy webhook payload
 * @param {Object} params.applicationData - Raw application object from Gupy webhook payload
 * @param {Date} params.webhookTimestamp - Event timestamp from webhook
 * @returns {Promise<{action: string, reason?: string, candidateId?: number, applicationId?: number, isNew?: boolean}>}
 */
async function upsertFromWebhook({ jobGupyId, applicationGupyId, candidateData, applicationData, webhookTimestamp }) {
  if (!candidateData || !candidateData.id) {
    console.error('[webhookCandidateService] Invalid candidateData: missing or no id');
    return { action: 'error', reason: 'invalid_candidate_data' };
  }

  // 1. Check if job exists locally
  const jobResult = await db.query(
    'SELECT id_job_subregional FROM job_subregional WHERE id_job_gupy = $1 AND ativo = true',
    [String(jobGupyId)]
  );

  if (jobResult.rows.length === 0) {
    return { action: 'skipped', reason: 'job_not_found' };
  }

  const idJobSubregional = jobResult.rows[0].id_job_subregional;

  // 2. Extract candidate fields from webhook payload
  const candidateGupyId = String(candidateData.id);
  const nome = `${candidateData.name || ''} ${candidateData.lastName || ''}`.trim() || 'Nome não disponível';
  const cpf = candidateData.identificationDocument || `GUPY_${candidateGupyId}`;
  const email = candidateData.email || null;
  const telefone = candidateData.mobileNumber || candidateData.phoneNumber || null;

  // 3. Transaction: UPSERT candidate + application
  let client;
  try {
    client = await db.getClient();
  } catch (err) {
    console.error('[webhookCandidateService] Failed to get DB client:', err.message);
    return { action: 'error', reason: 'db_connection_failed' };
  }

  try {
    await client.query('BEGIN');

    // 4. UPSERT candidate (with SAVEPOINT for CPF conflict recovery)
    let candidateId;
    let isNewCandidate = false;
    try {
      await client.query('SAVEPOINT candidate_insert');
      const candidateResult = await client.query(`
        INSERT INTO candidate (id_candidate_gupy, nome, cpf, email, telefone)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id_candidate_gupy) DO UPDATE SET
          nome = EXCLUDED.nome,
          email = COALESCE(NULLIF(EXCLUDED.email, ''), candidate.email),
          telefone = COALESCE(NULLIF(EXCLUDED.telefone, ''), candidate.telefone),
          updated_at = NOW()
        RETURNING id, (xmax = 0) AS is_new
      `, [
        candidateGupyId,
        nome,
        cpf,
        email,
        telefone,
      ]);

      await client.query('RELEASE SAVEPOINT candidate_insert');
      candidateId = candidateResult.rows[0].id;
      isNewCandidate = candidateResult.rows[0].is_new;
    } catch (err) {
      // CPF conflict: same CPF, different id_candidate_gupy
      if (err.code === '23505' && err.constraint?.includes('cpf')) {
        await client.query('ROLLBACK TO SAVEPOINT candidate_insert');
        console.warn(`[webhookCandidateService] CPF conflict for candidate_gupy=${candidateGupyId}, cpf=${cpf}. Using existing candidate.`);
        const existing = await client.query(
          'SELECT id FROM candidate WHERE cpf = $1',
          [cpf]
        );
        if (existing.rows.length === 0) {
          throw err; // Should not happen, re-throw
        }
        candidateId = existing.rows[0].id;
      } else {
        throw err;
      }
    }

    // 5. UPSERT application
    const stepInfo = applicationData?.currentStep;
    const statusApplication = normalizeStatus(applicationData?.status);
    const tags = applicationData?.tags ? JSON.stringify(applicationData.tags) : null;

    const appResult = await client.query(`
      INSERT INTO application (id_candidate, id_job_subregional, id_application_gupy, current_step_name, current_step_id, status_application, tags, step_updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id_application_gupy) DO UPDATE SET
        current_step_name = EXCLUDED.current_step_name,
        current_step_id = EXCLUDED.current_step_id,
        status_application = COALESCE(EXCLUDED.status_application, application.status_application),
        tags = COALESCE(EXCLUDED.tags, application.tags),
        step_updated_at = EXCLUDED.step_updated_at
      RETURNING id
    `, [
      candidateId,
      idJobSubregional,
      String(applicationGupyId),
      stepInfo?.name || null,
      stepInfo?.id || null,
      statusApplication,
      tags,
      webhookTimestamp,
    ]);

    await client.query('COMMIT');

    return {
      action: 'upserted',
      candidateId,
      applicationId: appResult.rows[0].id,
      isNew: isNewCandidate,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[webhookCandidateService] ROLLBACK also failed:', rollbackErr.message);
    }
    console.error('[webhookCandidateService] Transaction failed:', err.message, { code: err.code, detail: err.detail, constraint: err.constraint });
    return { action: 'error', reason: 'transaction_failed' };
  } finally {
    client.release();
  }
}

module.exports = { upsertFromWebhook, normalizeStatus };
