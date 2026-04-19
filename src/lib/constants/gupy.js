/**
 * Constantes para integração com Gupy
 */

// Página de carreiras "Tom Educação" na Gupy
const TOM_EDUCACAO_CAREER_PAGE_ID = 187780;

// Job boards gratuitos da Gupy
// 1 - Indeed (grátis, ativado por padrão)
// 3 - LinkedIn (grátis, requer ativação)
// 10 - Riovagas (grátis)
// 11 - Jooble (grátis)
// 12 - Netvagas (grátis)
// 13 - 99Hunters (grátis)
// 15 - Talent (grátis)
// 147 - Career Jet (grátis)
// 279 - Jobbol (grátis)
// 246 - Carreira Fashion (grátis)
// 213 - Yduqs (grátis)
// 180 - Recruta Simples (grátis)
const FREE_JOB_BOARDS = [1, 3, 10, 11, 12, 13, 15, 147, 279, 246, 213, 180];

// Status válidos para jobs na Gupy
const VALID_JOB_STATUSES = [
  'draft',
  'waiting_approval',
  'approved',
  'disapproved',
  'published',
  'frozen',
  'closed',
  'canceled',
];

module.exports = {
  TOM_EDUCACAO_CAREER_PAGE_ID,
  FREE_JOB_BOARDS,
  VALID_JOB_STATUSES,
};
