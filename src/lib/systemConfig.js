/**
 * Helper para acessar configuracoes do sistema
 *
 * Tabela: system_config
 * - key: string (PK)
 * - value: string
 * - description: string (opcional)
 * - updated_at: timestamp
 */

const db = require('../../db');

/**
 * Obtem valor de configuracao
 *
 * @param {string} key - Chave da configuracao
 * @param {string|null} defaultValue - Valor padrao se nao existir
 * @returns {Promise<string|null>} Valor da configuracao
 */
async function getConfig(key, defaultValue = null) {
  const result = await db.query(
    'SELECT value FROM system_config WHERE key = $1',
    [key]
  );

  if (result.rows.length === 0) {
    return defaultValue;
  }

  return result.rows[0].value;
}

/**
 * Define valor de configuracao (upsert)
 *
 * @param {string} key - Chave da configuracao
 * @param {string} value - Valor a ser definido
 */
async function setConfig(key, value) {
  await db.query(
    `INSERT INTO system_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

/**
 * Obtem intervalo de polling em milissegundos
 *
 * @returns {Promise<number>} Intervalo em ms (default: 60000)
 */
async function getPollingInterval() {
  const value = await getConfig('polling_interval_ms', '60000');
  return parseInt(value, 10);
}

/**
 * Verifica se contratacao automatica esta habilitada
 *
 * @returns {Promise<boolean>} true se habilitada
 */
async function isContratacaoAutomaticaEnabled() {
  const value = await getConfig('contratacao_automatica_enabled', 'false');
  return value === 'true';
}

module.exports = {
  getConfig,
  setConfig,
  getPollingInterval,
  isContratacaoAutomaticaEnabled,
};
