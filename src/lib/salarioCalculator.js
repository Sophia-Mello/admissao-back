const db = require('../../db');

/**
 * Busca o valor base da hora-aula na tabela salario_config
 *
 * @param {string} nomeFuncao - Nome da função (ex: "PROFESSOR(A)", "AEEI")
 * @param {string} tipoRemuneracao - Tipo de remuneração (default: "hora_aula")
 * @returns {Promise<number>} Valor base ou 0 se não encontrado
 */
async function buscarValorHoraAula(nomeFuncao, tipoRemuneracao = 'hora_aula') {
  if (!nomeFuncao) {
    console.warn('[salarioCalculator] nomeFuncao não fornecido, usando default');
    nomeFuncao = 'PROFESSOR(A)';
  }

  // Normalizar para uppercase e trim
  const nomeFuncaoNormalizado = nomeFuncao.toUpperCase().trim();

  const result = await db.query(
    `SELECT valor_base
     FROM salario_config
     WHERE UPPER(TRIM(nome_funcao)) = $1
       AND tipo_remuneracao = $2
       AND ativo = true
     LIMIT 1`,
    [nomeFuncaoNormalizado, tipoRemuneracao]
  );

  if (result.rows.length === 0) {
    console.warn(`[salarioCalculator] Salário não encontrado para função "${nomeFuncao}", usando default PROFESSOR(A)`);

    // Fallback para PROFESSOR(A)
    const fallbackResult = await db.query(
      `SELECT valor_base
       FROM salario_config
       WHERE nome_funcao = 'PROFESSOR(A)'
         AND tipo_remuneracao = $1
         AND ativo = true
       LIMIT 1`,
      [tipoRemuneracao]
    );

    return fallbackResult.rows[0]?.valor_base || 0;
  }

  return parseFloat(result.rows[0].valor_base);
}

/**
 * Calcula o salário mensal de professor hora-aula
 *
 * @param {number} valorHoraAula - Valor da hora-aula
 * @param {number} horasSemanais - Horas semanais de trabalho
 * @returns {number} Salário mensal calculado (arredondado para 2 casas decimais)
 *
 * @example
 * calcularSalarioMensal(27.3364, 1) // ~160.74
 * calcularSalarioMensal(27.3364, 10) // ~1607.4
 */
function calcularSalarioMensal(valorHoraAula, horasSemanais) {
  // Salário base (4.5 semanas por mês)
  const salarioBase = valorHoraAula * horasSemanais * 4.5;

  // DSR (Descanso Semanal Remunerado) = 16.67% do salário base
  const dsr = salarioBase * 0.1667;

  // Hora Atividade = 12% do salário com DSR
  const horaAtividade = salarioBase * 1.1667 * 0.12;

  // Total
  const total = salarioBase + dsr + horaAtividade;

  // Arredondar para 2 casas decimais
  return Math.round(total * 100) / 100;
}

/**
 * Normaliza nome de cargo removendo prefixo "BP - "
 *
 * @param {string|null|undefined} roleName - Nome do cargo
 * @returns {string|null} Nome normalizado ou null se input for null/undefined
 *
 * @example
 * normalizeRoleName('BP - PROFESSOR(A)') // 'PROFESSOR(A)'
 * normalizeRoleName('  bp - Coordenador  ') // 'Coordenador'
 * normalizeRoleName(null) // null
 */
function normalizeRoleName(roleName) {
  if (roleName === null || roleName === undefined) {
    return null;
  }

  // Trim whitespace first, then remove prefixo "BP - " (case insensitive)
  return roleName
    .trim()
    .replace(/^bp\s*-\s*/i, '')
    .trim();
}

module.exports = {
  calcularSalarioMensal,
  normalizeRoleName,
  buscarValorHoraAula
};
