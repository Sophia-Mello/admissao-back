/**
 * CV Sync Service
 * Handles syncing candidate CV data from Gupy.
 */

const db = require('../../db');
const gupyService = require('../services/gupyService');
const { transformGupyToCvData, calculateCvHash } = require('./cvTransformer');

const CACHE_DURATION_HOURS = 24;

/**
 * Check if cached CV data is still valid.
 * @param {Date|string|null} syncedAt - Last sync timestamp
 * @returns {boolean}
 */
function isCacheValid(syncedAt) {
  if (!syncedAt) return false;
  const syncDate = new Date(syncedAt);
  const hoursSinceSync = (Date.now() - syncDate.getTime()) / (1000 * 60 * 60);
  return hoursSinceSync < CACHE_DURATION_HOURS;
}

/**
 * Get CV data for a candidate, syncing from Gupy if needed.
 *
 * @param {number} candidateId - Local candidate ID
 * @param {Object} options
 * @param {boolean} options.forceSync - Force sync even if cache valid
 * @returns {Promise<Object>} CV data
 */
async function getCandidateCv(candidateId, options = {}) {
  const { forceSync = false } = options;

  const { rows } = await db.query(
    `SELECT id, id_candidate_gupy, nome, email, cv_data, cv_data_hash, gupy_synced_at
     FROM candidate WHERE id = $1`,
    [candidateId]
  );

  if (rows.length === 0) {
    throw new Error('Candidato não encontrado');
  }

  const candidate = rows[0];
  const needsSync = forceSync || !candidate.cv_data || !isCacheValid(candidate.gupy_synced_at);

  if (!needsSync && candidate.cv_data) {
    console.log(`[cvSync] Returning cached CV for candidate ${candidateId}`);
    return {
      ...candidate.cv_data,
      fromCache: true,
      syncedAt: candidate.gupy_synced_at,
    };
  }

  if (!candidate.id_candidate_gupy) {
    console.log(`[cvSync] Candidate ${candidateId} has no Gupy ID, returning basic info`);
    // Return basic info if no Gupy ID
    return {
      nome: candidate.nome,
      email: candidate.email,
      formacao: [],
      experiencia: [],
      idiomas: [],
      fromCache: false,
      syncedAt: null,
      noGupyId: true,
    };
  }

  return syncCandidateFromGupy(candidateId, candidate.id_candidate_gupy);
}

/**
 * Sync ALL candidate data from Gupy API.
 * Updates basic info (name, email, phone, cpf) AND CV data.
 * Candidates may change their info at any time in Gupy.
 *
 * @param {number} candidateId - Local candidate ID
 * @param {string} gupyCandidateId - Gupy candidate ID
 * @returns {Promise<Object>} Synced CV data
 */
async function syncCandidateFromGupy(candidateId, gupyCandidateId) {
  console.log(`[cvSync] Syncing candidate ${candidateId} from Gupy (${gupyCandidateId})...`);

  const gupyCandidate = await gupyService.fetchCandidateById(gupyCandidateId);
  const cvData = transformGupyToCvData(gupyCandidate);
  const newHash = calculateCvHash(cvData);

  // Extract basic candidate info from Gupy response
  const basicInfo = {
    nome: `${gupyCandidate.firstName || ''} ${gupyCandidate.lastName || ''}`.trim(),
    email: gupyCandidate.emailAddresses?.[0] || null,
    telefone: gupyCandidate.phoneNumbers?.[0] || null,
    // CPF comes from identityDocument (Brazilian ID)
    cpf: gupyCandidate.identityDocument?.number?.replace(/\D/g, '') || null,
  };

  // Update ALL fields - candidates may change their info in Gupy at any time
  await db.query(
    `UPDATE candidate
     SET
       nome = COALESCE($1, nome),
       email = COALESCE($2, email),
       telefone = COALESCE($3, telefone),
       cpf = COALESCE($4, cpf),
       cv_data = $5,
       cv_data_hash = $6,
       gupy_synced_at = NOW()
     WHERE id = $7`,
    [
      basicInfo.nome || null,
      basicInfo.email || null,
      basicInfo.telefone || null,
      basicInfo.cpf || null,
      JSON.stringify(cvData),
      newHash,
      candidateId
    ]
  );

  console.log(`[cvSync] Candidate ${candidateId} fully synced (hash: ${newHash.substring(0, 8)}...)`);

  return {
    ...cvData,
    // Include updated basic info in response
    nome: basicInfo.nome || cvData.nome,
    email: basicInfo.email || cvData.email,
    telefone: basicInfo.telefone || cvData.telefone,
    fromCache: false,
    syncedAt: new Date().toISOString(),
  };
}

module.exports = {
  getCandidateCv,
  syncCandidateFromGupy,
  isCacheValid,
  CACHE_DURATION_HOURS,
};
