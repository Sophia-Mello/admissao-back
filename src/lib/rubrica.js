/**
 * Rubrica (Evaluation Form) URL Builder
 *
 * Builds pre-filled Google Forms URLs for candidate evaluation rubrica.
 *
 * Environment variables required:
 * - RUBRICA_FORM_BASE: Base Google Forms URL
 * - RUBRICA_FIELD_BOOKING_ID: Entry ID for booking_id field
 * - RUBRICA_FIELD_NOME: Entry ID for candidate name field
 * - RUBRICA_FIELD_CPF: Entry ID for CPF field
 * - RUBRICA_FIELD_VAGA: Entry ID for job name field
 * - RUBRICA_FIELD_ESCOLA: Entry ID for school/unit field
 */

const RUBRICA_FORM_BASE = process.env.RUBRICA_FORM_BASE;
const RUBRICA_FIELD_BOOKING_ID = process.env.RUBRICA_FIELD_BOOKING_ID;
const RUBRICA_FIELD_NOME = process.env.RUBRICA_FIELD_NOME;
const RUBRICA_FIELD_CPF = process.env.RUBRICA_FIELD_CPF;
const RUBRICA_FIELD_VAGA = process.env.RUBRICA_FIELD_VAGA;
const RUBRICA_FIELD_ESCOLA = process.env.RUBRICA_FIELD_ESCOLA;

/**
 * Build pre-filled Google Forms URL for rubrica
 *
 * @param {object} params - Form data
 * @param {number} params.booking_id - Booking ID
 * @param {string} params.nome - Candidate name
 * @param {string} params.cpf - Candidate CPF
 * @param {string} params.vaga - Job name/title
 * @param {string} params.escola - School/unit name
 * @returns {string} Pre-filled Google Forms URL
 */
function buildRubricaUrl({ booking_id, nome, cpf, vaga, escola }) {
  if (!RUBRICA_FORM_BASE) {
    console.warn('[RUBRICA] RUBRICA_FORM_BASE not set, returning placeholder URL');
    return 'https://forms.google.com/placeholder';
  }

  // Build URL with URLSearchParams for proper encoding
  const params = new URLSearchParams();
  params.append('usp', 'pp_url'); // Pre-populated URL parameter

  if (RUBRICA_FIELD_BOOKING_ID && booking_id) {
    params.append(RUBRICA_FIELD_BOOKING_ID, booking_id);
  }
  if (RUBRICA_FIELD_NOME && nome) {
    params.append(RUBRICA_FIELD_NOME, nome);
  }
  if (RUBRICA_FIELD_CPF && cpf) {
    params.append(RUBRICA_FIELD_CPF, cpf);
  }
  if (RUBRICA_FIELD_VAGA && vaga) {
    params.append(RUBRICA_FIELD_VAGA, vaga);
  }
  if (RUBRICA_FIELD_ESCOLA && escola) {
    params.append(RUBRICA_FIELD_ESCOLA, escola);
  }

  return `${RUBRICA_FORM_BASE}?${params.toString()}`;
}

module.exports = {
  buildRubricaUrl,
};
