/**
 * Mapeamento de UF para nome completo dos estados brasileiros
 * Usado para converter dados do ViaCEP para formato da API Gupy
 */
const BRAZILIAN_STATES = {
  'AC': 'Acre',
  'AL': 'Alagoas',
  'AP': 'Amapá',
  'AM': 'Amazonas',
  'BA': 'Bahia',
  'CE': 'Ceará',
  'DF': 'Distrito Federal',
  'ES': 'Espírito Santo',
  'GO': 'Goiás',
  'MA': 'Maranhão',
  'MT': 'Mato Grosso',
  'MS': 'Mato Grosso do Sul',
  'MG': 'Minas Gerais',
  'PA': 'Pará',
  'PB': 'Paraíba',
  'PR': 'Paraná',
  'PE': 'Pernambuco',
  'PI': 'Piauí',
  'RJ': 'Rio de Janeiro',
  'RN': 'Rio Grande do Norte',
  'RS': 'Rio Grande do Sul',
  'RO': 'Rondônia',
  'RR': 'Roraima',
  'SC': 'Santa Catarina',
  'SP': 'São Paulo',
  'SE': 'Sergipe',
  'TO': 'Tocantins'
};

/**
 * Retorna o nome completo do estado a partir da sigla
 * @param {string} uf - Sigla do estado (ex: "PR")
 * @returns {string} Nome completo do estado (ex: "Paraná")
 */
function getFullStateName(uf) {
  return BRAZILIAN_STATES[uf] || uf;
}

module.exports = {
  BRAZILIAN_STATES,
  getFullStateName
};
