/**
 * Helpers puros para operações de jobs
 *
 * Consolidado de:
 * - lib/jobGupy.js (helpers de criação)
 * - lib/jobPublish.js (helpers de publicação)
 */

const gupyService = require('../services/gupyService');
const { getFullStateName } = require('./brazilianStates');

// ============================================================================
// CONSTANTS (re-export de constants/gupy.js)
// ============================================================================

const {
  TOM_EDUCACAO_CAREER_PAGE_ID,
  FREE_JOB_BOARDS,
  VALID_JOB_STATUSES,
} = require('./constants/gupy');

// ============================================================================
// PURE HELPERS - Funções sem side-effects
// ============================================================================

/**
 * Extrai o código do nome do template
 *
 * Template: "Professor de Matemática | XXXXX"
 * Resultado: "XXXXX"
 *
 * @param {string} templateName - Nome do template
 * @returns {string} Código extraído ou gerado
 */
function extractJobCode(templateName) {
  if (!templateName) {
    return `COD${Date.now()}`;
  }

  if (templateName.includes('|')) {
    const separatorIndex = templateName.lastIndexOf('|');
    return templateName.substring(separatorIndex + 1).trim();
  }

  return `COD${Date.now()}`;
}

/**
 * Monta nome do job seguindo convenção
 *
 * Template: "Professor de Matemática | XXXXX"
 * Resultado: "Professor de Matemática | {Subregional} | XXXXX"
 *
 * @param {string} templateName - Nome do template
 * @param {string} subregionalName - Nome da subregional
 * @returns {string} Nome formatado do job
 */
function buildJobName(templateName, subregionalName) {
  const fullTemplateName = templateName || 'Vaga';

  if (fullTemplateName.includes('|')) {
    const separatorIndex = fullTemplateName.indexOf('|');
    const cargoNome = fullTemplateName.substring(0, separatorIndex).trim();
    const codigo = fullTemplateName.substring(separatorIndex + 1).trim();
    return `${cargoNome} | ${subregionalName} | ${codigo}`;
  }

  return `${fullTemplateName} | ${subregionalName} | COD${Date.now()}`;
}

/**
 * Faz parse do endereço da subregional
 *
 * Formato esperado: "CIDADE, ESTADO, BRASIL, CEP"
 * Exemplo: "CURITIBA, PARANA, BRASIL, 81590-370"
 *
 * @param {string} endereco - Endereço no formato "CIDADE, ESTADO, PAIS, CEP"
 * @returns {Object|null} Dados parseados do endereço
 */
function parseEndereco(endereco) {
  if (!endereco) {
    return null;
  }

  const parts = endereco.split(',').map((p) => p.trim());

  if (parts.length < 4) {
    console.warn('[JobHelpers] Endereço com formato inválido:', endereco);
    return null;
  }

  const [cidade, estado, pais, cep] = parts;

  // Estado vem como "PARANA", precisamos do nome completo e sigla
  const estadoUpper = estado.toUpperCase();
  const ufMap = {
    PARANA: 'PR',
    'SAO PAULO': 'SP',
    'RIO DE JANEIRO': 'RJ',
    'MINAS GERAIS': 'MG',
    'RIO GRANDE DO SUL': 'RS',
    'SANTA CATARINA': 'SC',
    BAHIA: 'BA',
    PERNAMBUCO: 'PE',
    CEARA: 'CE',
    GOIAS: 'GO',
    'MATO GROSSO': 'MT',
    'MATO GROSSO DO SUL': 'MS',
    'ESPIRITO SANTO': 'ES',
    AMAZONAS: 'AM',
    PARA: 'PA',
    MARANHAO: 'MA',
    PIAUI: 'PI',
    'RIO GRANDE DO NORTE': 'RN',
    PARAIBA: 'PB',
    ALAGOAS: 'AL',
    SERGIPE: 'SE',
    TOCANTINS: 'TO',
    RONDONIA: 'RO',
    ACRE: 'AC',
    AMAPA: 'AP',
    RORAIMA: 'RR',
    'DISTRITO FEDERAL': 'DF',
  };

  const uf = ufMap[estadoUpper] || 'PR';

  return {
    cidade: cidade.charAt(0).toUpperCase() + cidade.slice(1).toLowerCase(),
    estado: getFullStateName(uf),
    uf,
    pais: 'Brasil',
    cep,
  };
}

/**
 * Monta payload de publicação para a Gupy
 *
 * @param {Object} options
 * @param {string} options.endereco - Endereço da subregional
 * @param {string} options.hiringDeadline - Data limite de contratação (ISO)
 * @param {string} options.applicationDeadline - Data limite de inscrição (ISO)
 * @param {number[]} [options.jobBoards] - IDs dos job boards (default: FREE_JOB_BOARDS)
 * @param {boolean} [options.publishStatus] - Se deve mudar status para published
 * @returns {Object} Payload para API da Gupy
 */
function buildPublishPayload(options) {
  const {
    endereco,
    hiringDeadline,
    applicationDeadline,
    jobBoards = FREE_JOB_BOARDS,
    publishStatus = false,
  } = options;

  const payload = {
    careerPageId: TOM_EDUCACAO_CAREER_PAGE_ID,
  };

  // Job boards
  if (jobBoards && jobBoards.length > 0) {
    payload.jobBoards = jobBoards;
  }

  // Datas
  if (hiringDeadline) {
    payload.hiringDeadline = hiringDeadline;
  }

  if (applicationDeadline) {
    payload.applicationDeadline = applicationDeadline;
  }

  // Endereço (parse automático)
  const addressData = parseEndereco(endereco);
  if (addressData) {
    payload.addressStreet = '';
    payload.addressNumber = 'S/N';
    payload.addressDistrict = '';
    payload.addressCity = addressData.cidade;
    payload.addressState = addressData.estado;
    payload.addressStateShortName = addressData.uf;
    payload.addressCountry = addressData.pais;
    payload.addressCountryShortName = 'BRA';
  }

  // Status
  if (publishStatus) {
    payload.status = 'published';
  }

  return payload;
}

// ============================================================================
// VALIDATORS - Validações de regras de negócio
// ============================================================================

/**
 * Valida campos obrigatórios para publicação
 *
 * @param {Object} job - Job do banco de dados
 * @returns {Object} { valid: boolean, missingFields: string[] }
 */
function validatePublishRequirements(job) {
  const missingFields = [];

  if (!job.description) missingFields.push('description');
  if (!job.responsibilities) missingFields.push('responsibilities');
  if (!job.prerequisites) missingFields.push('prerequisites');

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

// ============================================================================
// GUPY TEMPLATE HELPERS - Busca e validação de templates
// ============================================================================

/**
 * Busca e valida template da Gupy
 *
 * @param {string|number} templateId - ID do template na Gupy
 * @returns {Promise<Object>} Template completo com campos HTML
 * @throws {Error} Se template não encontrado ou inválido
 */
async function fetchAndValidateTemplate(templateId) {
  console.log('[JobHelpers] Buscando template:', templateId);

  const templatesData = await gupyService.listJobTemplates({
    perPage: '100',
    fields: 'all',
  });

  const template = templatesData.results?.find(
    (t) => String(t.id) === String(templateId)
  );

  if (!template) {
    const error = new Error(`Template ${templateId} não encontrado na Gupy`);
    error.status = 404;
    throw error;
  }

  // Validar campos obrigatórios
  const requiredFields = ['type', 'departmentId', 'roleId'];
  const missingFields = requiredFields.filter((field) => !template[field]);

  if (missingFields.length > 0) {
    const error = new Error(
      `Template inválido: campos obrigatórios ausentes: ${missingFields.join(', ')}`
    );
    error.status = 400;
    throw error;
  }

  console.log('[JobHelpers] Template válido:', {
    id: template.id,
    name: template.name || template.title,
    type: template.type,
    hasDescription: !!template.description,
    hasResponsibilities: !!template.responsibilities,
    hasPrerequisites: !!template.prerequisites,
  });

  return template;
}

// ============================================================================
// GUPY WRAPPERS - Thin wrappers sobre gupyService
// ============================================================================

/**
 * Cria job na Gupy
 *
 * @param {Object} params
 * @param {number} params.templateId - ID do template
 * @param {string} params.name - Nome do job
 * @param {string} params.code - Código do job
 * @param {string} params.type - Tipo do job (do template)
 * @param {number} params.departmentId - ID do departamento (do template)
 * @param {number} params.roleId - ID do cargo (do template)
 * @returns {Promise<Object>} Job criado na Gupy
 */
async function createJobInGupy({ templateId, name, code, type, departmentId, roleId }) {
  const payload = {
    templateId,
    name,
    code: code || `COD${Date.now()}`,
    type,
    publicationType: 'external',
    numVacancies: 1,
    departmentId,
    roleId,
  };

  console.log('[JobHelpers] Criando job na Gupy:', JSON.stringify(payload, null, 2));

  const job = await gupyService.createJob(payload);

  console.log('[JobHelpers] Job criado:', job.id);

  return job;
}

/**
 * Busca status de múltiplos jobs na Gupy
 *
 * @param {string[]} jobIds - IDs dos jobs na Gupy
 * @returns {Promise<Object>} Map de jobId -> { status, exists_in_gupy, name }
 */
async function getJobsStatusFromGupy(jobIds) {
  if (!jobIds || jobIds.length === 0) {
    return {};
  }

  try {
    console.log(`[JobHelpers] Verificando status de ${jobIds.length} vagas...`);
    return await gupyService.getJobsStatus(jobIds);
  } catch (error) {
    console.error('[JobHelpers] Erro ao buscar status:', error.message);
    return {};
  }
}

/**
 * Atualiza status de um job na Gupy
 *
 * @param {string} gupyJobId - ID do job na Gupy
 * @param {string} status - Novo status
 * @returns {Promise<Object>} Job atualizado
 */
async function updateJobStatus(gupyJobId, status) {
  console.log(`[JobHelpers] Atualizando status do job ${gupyJobId} para: ${status}`);

  const result = await gupyService.updateJob(gupyJobId, { status });

  console.log('[JobHelpers] Status atualizado');

  return result;
}

/**
 * Publica job nos portais de emprego
 *
 * @param {string} gupyJobId - ID do job na Gupy
 * @param {Object} options - Opções de publicação
 * @returns {Promise<Object>} Resultado da publicação
 */
async function publishJob(gupyJobId, options) {
  const payload = buildPublishPayload(options);

  console.log('[JobHelpers] Publicando job:', gupyJobId);
  console.log('[JobHelpers] Payload:', JSON.stringify(payload, null, 2));

  const result = await gupyService.updateJob(gupyJobId, payload);

  console.log('[JobHelpers] Job publicado');

  return result;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  TOM_EDUCACAO_CAREER_PAGE_ID,
  FREE_JOB_BOARDS,
  VALID_JOB_STATUSES,
  // Pure helpers
  extractJobCode,
  buildJobName,
  parseEndereco,
  buildPublishPayload,
  // Validators
  validatePublishRequirements,
  // Template helpers
  fetchAndValidateTemplate,
  // Gupy wrappers
  createJobInGupy,
  getJobsStatusFromGupy,
  updateJobStatus,
  publishJob,
};
