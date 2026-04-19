const db = require('../../db');

/**
 * Verifica se candidato já tem booking (agendado ou compareceu) em uma unidade
 * Verifica TODAS as applications do candidato, não apenas uma específica
 *
 * @param {object} client - Database client (for transactions)
 * @param {number} candidateId - ID do candidato (tabela candidate)
 * @param {number} unidadeId - ID da unidade
 * @returns {object|null} - Booking encontrado ou null
 */
async function checkCandidateUnitBooking(client, candidateId, unidadeId) {
  const result = await client.query(
    `SELECT b.id_booking, b.status_booking, b.start_at, b.end_at
     FROM booking b
     JOIN job_unidade ju ON b.id_job_unidade = ju.id_job_unidade
     JOIN application a ON b.id_application_gupy = a.id_application_gupy
     WHERE a.id_candidate = $1
       AND ju.id_unidade = $2
       AND b.status_booking IN ('agendado', 'compareceu')
     LIMIT 1`,
    [candidateId, unidadeId]
  );

  return result.rows[0] || null;
}

/**
 * Valida regras de negócio para booking
 * - Máximo 1 booking ativo por application
 * - Máximo 1 booking (agendado/compareceu) por candidato+unidade (APENAS fluxo público)
 *
 * @param {object} client - Database client
 * @param {string} applicationId - ID da application no Gupy
 * @param {number} id_job_unidade - ID do job_unidade
 * @param {object} options - Opções adicionais
 * @param {number} options.candidateId - ID do candidato
 * @param {number} options.unidadeId - ID da unidade
 * @param {boolean} options.isPublicFlow - Se é fluxo público
 */
async function validateBookingBusinessRules(client, applicationId, id_job_unidade, options = {}) {
  const { candidateId, unidadeId, isPublicFlow = false } = options;

  // Regra 1: Verifica booking ativo (aplica sempre)
  const activeBooking = await client.query(
    `SELECT id_booking FROM booking
     WHERE id_application_gupy = $1 AND status_booking = 'agendado'`,
    [applicationId]
  );

  if (activeBooking.rows.length > 0) {
    return { valid: false, error: 'Candidato já possui agendamento ativo' };
  }

  // Regra 2: Verifica candidato+unidade (APENAS fluxo público)
  if (isPublicFlow && candidateId && unidadeId) {
    const existingBooking = await checkCandidateUnitBooking(client, candidateId, unidadeId);

    if (existingBooking) {
      return { valid: false, error: 'Você já possui agendamento nesta unidade' };
    }
  }

  return { valid: true };
}

/**
 * Verifica se candidato tem histórico de falta (no-show)
 * Regra: 1 strike = bloqueado
 */
async function checkNoShowHistory(client, applicationId) {
  const noShow = await client.query(
    `SELECT id_booking FROM booking
     WHERE id_application_gupy = $1 AND status_booking = 'faltou'
     LIMIT 1`,
    [applicationId]
  );

  return noShow.rows.length > 0;
}

/**
 * Busca booking por ID com dados da unidade
 */
async function getBookingById(id_booking) {
  const result = await db.query(`
    SELECT
      b.*,
      ju.id_unidade,
      u.nome_unidade,
      u.email_unidade_agendador
    FROM booking b
    JOIN job_unidade ju ON ju.id_job_unidade = b.id_job_unidade
    JOIN unidade u ON u.id_unidade = ju.id_unidade
    WHERE b.id_booking = $1
  `, [id_booking]);

  return result.rows[0] || null;
}

module.exports = {
  validateBookingBusinessRules,
  checkNoShowHistory,
  checkCandidateUnitBooking,
  getBookingById
};
