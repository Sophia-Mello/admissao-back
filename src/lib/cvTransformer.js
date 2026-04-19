/**
 * CV Transformer Utilities
 * Transforms Gupy candidate data to structured CV format.
 */

const crypto = require('crypto');

const DEGREE_LABELS = {
  high_school: 'Ensino Médio',
  technical: 'Técnico',
  technical_course: 'Curso Técnico',
  technological: 'Tecnólogo',
  graduation: 'Graduação',
  post_graduate: 'Pós-Graduação',
  postgraduate: 'Pós-Graduação',
  master: 'Mestrado',
  doctorate: 'Doutorado',
  mba: 'MBA',
};

const LANGUAGE_LABELS = {
  portuguese: 'Português',
  english: 'Inglês',
  spanish: 'Espanhol',
  french: 'Francês',
  german: 'Alemão',
  italian: 'Italiano',
};

const LEVEL_LABELS = {
  basic: 'Básico',
  intermediate: 'Intermediário',
  advanced: 'Avançado',
  fluent: 'Fluente',
  native: 'Nativo',
};

/**
 * Format period string from start and end years.
 * @param {number|null} startYear
 * @param {number|null} endYear
 * @returns {string}
 */
function formatPeriod(startYear, endYear) {
  if (!startYear) return '';
  return `${startYear} - ${endYear || 'Atual'}`;
}

/**
 * Transform Gupy candidate data to structured CV format.
 * @param {Object} gupyCandidate - Raw candidate data from Gupy API
 * @returns {Object} Structured CV data
 */
function transformGupyToCvData(gupyCandidate) {
  const address = gupyCandidate.addresses?.[0] || {};

  return {
    gupy_candidate_id: gupyCandidate.id,
    nome: `${gupyCandidate.firstName || ''} ${gupyCandidate.lastName || ''}`.trim(),
    email: gupyCandidate.emailAddresses?.[0] || '',
    telefone: gupyCandidate.phoneNumbers?.[0] || '',
    data_nascimento: gupyCandidate.birthdate || null,
    endereco: address.city ? `${address.city}, ${address.stateCode}` : '',
    formacao: (gupyCandidate.education || []).map(e => ({
      grau: DEGREE_LABELS[e.degree] || e.degree || '',
      curso: e.course || '',
      instituicao: e.institution || '',
      status: e.status || '',
      periodo: formatPeriod(e.startYear, e.endYear),
    })),
    experiencia: (gupyCandidate.experience || []).map(e => ({
      cargo: e.role || '',
      empresa: e.organization || '',
      descricao: e.activitiesPerformed || '',
      periodo: formatPeriod(e.startYear, e.endYear),
    })),
    idiomas: (gupyCandidate.languages || []).map(l => ({
      nome: LANGUAGE_LABELS[l.name] || l.name || '',
      nivel: LEVEL_LABELS[l.level] || l.level || '',
    })),
    synced_at: new Date().toISOString(),
  };
}

/**
 * Calculate MD5 hash of CV data for change detection.
 * Uses sorted keys to ensure consistent hash regardless of property order.
 * @param {Object} cvData
 * @returns {string} 32-character hex MD5 hash
 */
function calculateCvHash(cvData) {
  // Sort keys recursively for consistent hashing
  const sortedJson = JSON.stringify(cvData, Object.keys(cvData).sort());
  return crypto.createHash('md5').update(sortedJson).digest('hex');
}

module.exports = {
  transformGupyToCvData,
  calculateCvHash,
  DEGREE_LABELS,
  LANGUAGE_LABELS,
  LEVEL_LABELS,
};
