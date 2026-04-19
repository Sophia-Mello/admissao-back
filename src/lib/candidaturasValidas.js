const db = require('../../db');

/**
 * Busca todas as candidaturas válidas de um candidato em uma unidade
 *
 * Candidaturas válidas são aquelas que:
 * - Pertencem ao mesmo candidato
 * - Têm a unidade configurada em job_unidade
 * - Estão na etapa "Aula Teste" ou "Entrevista"
 *
 * @param {number} candidateId - ID do candidato
 * @param {number} unidadeId - ID da unidade
 * @returns {Promise<string[]>} - Array de job_name
 */
async function getCandidaturasValidas(candidateId, unidadeId) {
  const result = await db.query(
    `SELECT DISTINCT js.job_name
     FROM application a
     JOIN job_subregional js ON a.id_job_subregional = js.id_job_subregional
     JOIN job_unidade ju ON js.id_job_subregional = ju.id_job_subregional
     WHERE a.id_candidate = $1
       AND ju.id_unidade = $2
       AND a.current_step_name IN ('Aula Teste', 'Entrevista')
       AND ju.active = true
       AND js.ativo = true
     ORDER BY js.job_name`,
    [candidateId, unidadeId]
  );

  return result.rows.map(row => row.job_name);
}

module.exports = { getCandidaturasValidas };
