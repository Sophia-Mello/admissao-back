/**
 * Gupy API Service
 *
 * Service para integração com a API da Gupy Recrutamento & Seleção
 * Documentação: https://developers.gupy.io/reference/introduction
 */

const axios = require('axios');

// Configuração da API Gupy
const GUPY_API_URL = process.env.GUPY_API_URL || 'https://api.gupy.io';
const GUPY_API_KEY = process.env.GUPY_API_KEY;

if (!GUPY_API_KEY) {
  console.warn('⚠️  GUPY_API_KEY não configurada. A integração com Gupy não funcionará.');
}

/**
 * Cliente HTTP configurado para Gupy API
 */
const gupyClient = axios.create({
  baseURL: GUPY_API_URL,
  timeout: 30000, // 30 segundos
  headers: {
    'Authorization': `Bearer ${GUPY_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Interceptor para logging de requisições
 */
gupyClient.interceptors.request.use(
  (config) => {
    // Build full URL with params for logging
    let fullUrl = config.url;
    if (config.params) {
      const params = new URLSearchParams(config.params).toString();
      fullUrl = `${config.url}?${params}`;
    }
    console.log(`[Gupy API] ${config.method.toUpperCase()} ${fullUrl}`);
    return config;
  },
  (error) => {
    console.error('[Gupy API] Erro na requisição:', error.message);
    return Promise.reject(error);
  }
);

/**
 * Interceptor para tratamento de erros de resposta
 */
gupyClient.interceptors.response.use(
  (response) => {
    console.log(`[Gupy API] ✓ ${response.config.method.toUpperCase()} ${response.config.url} - ${response.status}`);
    return response;
  },
  (error) => {
    if (error.response) {
      // Erro com resposta do servidor
      console.error(`[Gupy API] ✗ ${error.config.method.toUpperCase()} ${error.config.url} - ${error.response.status}`);
      console.error('[Gupy API] Erro:', error.response.data);
    } else if (error.request) {
      // Erro sem resposta (timeout, network error)
      console.error('[Gupy API] Sem resposta do servidor:', error.message);
    } else {
      console.error('[Gupy API] Erro:', error.message);
    }
    return Promise.reject(error);
  }
);

/**
 * Service da Gupy API
 */
const gupyService = {
  /**
   * Lista todos os job templates disponíveis
   * GET /api/v1/job-templates
   *
   * @param {Object} options - Opções de paginação e campos
   * @param {string} [options.perPage] - Número de itens por página (padrão: 100)
   * @param {string} [options.page] - Página atual (padrão: 1)
   * @param {string} [options.fields] - Campos a retornar (ex: 'all' para todos os campos)
   * @returns {Promise<Object>} Resposta com results, totalResults, page, totalPages
   */
  async listJobTemplates(options = {}) {
    try {
      const { perPage = '100', page = '1', fields } = options;

      const params = { perPage, page };

      // Adicionar fields se fornecido
      if (fields) {
        params.fields = fields;
      }

      const response = await gupyClient.get('/api/v1/job-templates', { params });

      // Retornar dados completos da API Gupy
      // A API retorna: { results: [...], totalResults: N, page: N, totalPages: N }
      return response.data || { results: [], totalResults: 0, page: 1, totalPages: 0 };
    } catch (error) {
      throw this._handleError(error, 'Erro ao listar job templates');
    }
  },

  /**
   * Busca detalhes de um job template específico
   * GET /api/v1/job-templates/{jobTemplateId}/custom-fields
   *
   * @param {string} jobTemplateId - ID do job template
   * @returns {Promise<Object>} Detalhes do job template (apenas custom fields)
   */
  async getJobTemplate(jobTemplateId) {
    try {
      const response = await gupyClient.get(`/api/v1/job-templates/${jobTemplateId}/custom-fields`);
      return response.data;
    } catch (error) {
      throw this._handleError(error, `Erro ao buscar job template ${jobTemplateId}`);
    }
  },

  /**
   * Busca detalhes completos de um job template (com description, responsibilities, etc)
   * GET /api/v1/job-templates/{jobTemplateId}
   *
   * @param {string} jobTemplateId - ID do job template
   * @param {Object} options - Opções da requisição
   * @param {string} [options.fields] - Campos a retornar (ex: 'all' para todos os campos)
   * @returns {Promise<Object>} Detalhes completos do job template
   */
  async getJobTemplateComplete(jobTemplateId, options = {}) {
    try {
      const params = {};

      // Adicionar parâmetro fields se fornecido
      if (options.fields) {
        params.fields = options.fields;
      }

      const response = await gupyClient.get(`/api/v1/job-templates/${jobTemplateId}`, { params });
      return response.data;
    } catch (error) {
      throw this._handleError(error, `Erro ao buscar job template completo ${jobTemplateId}`);
    }
  },

  /**
   * Cria um novo job na Gupy com base em um template
   * POST /api/v1/jobs
   *
   * @param {Object} jobData - Dados do job
   * @param {number} jobData.templateId - ID do template a ser usado (OBRIGATÓRIO)
   * @param {string} jobData.name - Nome da vaga (OBRIGATÓRIO)
   * @param {string} jobData.type - Tipo da vaga (OBRIGATÓRIO, ex: vacancy_type_talent_pool)
   * @param {string} jobData.publicationType - Tipo de publicação (OBRIGATÓRIO: external | internal)
   * @param {number} jobData.numVacancies - Número de vagas (OBRIGATÓRIO)
   * @param {number} jobData.departmentId - ID do departamento (OBRIGATÓRIO)
   * @param {number} jobData.roleId - ID da função/cargo (OBRIGATÓRIO)
   * @param {string} [jobData.code] - Código da vaga (opcional)
   * @param {string} [jobData.description] - Descrição da vaga (opcional)
   * @param {Object} [jobData.customFields] - Campos customizados (opcional)
   * @returns {Promise<Object>} Job criado
   */
  async createJob(jobData) {
    try {
      // Validar campos obrigatórios
      if (!jobData.templateId) {
        throw new Error('templateId é obrigatório');
      }
      if (!jobData.name) {
        throw new Error('name é obrigatório');
      }
      if (!jobData.type) {
        throw new Error('type é obrigatório (deve vir do template)');
      }
      if (!jobData.publicationType) {
        throw new Error('publicationType é obrigatório (external ou internal)');
      }
      if (!jobData.numVacancies) {
        throw new Error('numVacancies é obrigatório');
      }
      if (!jobData.departmentId) {
        throw new Error('departmentId é obrigatório (deve vir do template)');
      }
      if (!jobData.roleId) {
        throw new Error('roleId é obrigatório (deve vir do template)');
      }

      // Montar payload com campos obrigatórios
      const payload = {
        templateId: jobData.templateId,
        name: jobData.name,
        type: jobData.type,
        publicationType: jobData.publicationType,
        numVacancies: jobData.numVacancies,
        departmentId: jobData.departmentId,
        roleId: jobData.roleId,
      };

      // Adicionar campos opcionais se fornecidos
      if (jobData.code) payload.code = jobData.code;
      if (jobData.description) payload.description = jobData.description;
      if (jobData.customFields) payload.customFields = jobData.customFields;

      console.log('[Gupy API] Criando job com payload:', JSON.stringify(payload, null, 2));

      const response = await gupyClient.post('/api/v1/jobs', payload);

      console.log('[Gupy API] ✓ Job criado com sucesso:', response.data.id);

      return response.data;
    } catch (error) {
      throw this._handleError(error, 'Erro ao criar job na Gupy');
    }
  },

  /**
   * Busca informações de um job específico
   * GET /api/v1/jobs/{jobId}
   *
   * @param {string} jobId - ID do job
   * @param {Object} options - Opções da requisição
   * @param {string} [options.fields] - Campos a retornar (ex: 'all' para todos os campos)
   * @returns {Promise<Object>} Informações do job (incluindo description do template)
   */
  async getJob(jobId, options = {}) {
    try {
      const params = {};

      // Adicionar parâmetro fields se fornecido
      if (options.fields) {
        params.fields = options.fields;
      }

      const response = await gupyClient.get(`/api/v1/jobs/${jobId}`, { params });
      return response.data;
    } catch (error) {
      throw this._handleError(error, `Erro ao buscar job ${jobId}`);
    }
  },

  /**
   * Atualiza um job existente na Gupy
   * PATCH /api/v1/jobs/{jobId}
   *
   * @param {string} jobId - ID do job
   * @param {Object} updateData - Dados para atualização
   * @param {string} [updateData.status] - Status da vaga (draft, published, frozen, closed, etc)
   * @param {Array<number>} [updateData.jobBoards] - IDs dos job boards para publicação
   * @param {string} [updateData.name] - Nome da vaga
   * @param {string} [updateData.description] - Descrição da vaga
   * @param {string} [updateData.code] - Código da vaga
   * @param {string} [updateData.hiringDeadline] - Data limite de contratação
   * @returns {Promise<Object>} Job atualizado
   */
  async updateJob(jobId, updateData) {
    try {
      console.log('[Gupy API] Atualizando job com payload:', JSON.stringify(updateData, null, 2));

      const response = await gupyClient.patch(`/api/v1/jobs/${jobId}`, updateData);

      console.log('[Gupy API] ✓ Job atualizado com sucesso:', response.data.id);

      return response.data;
    } catch (error) {
      throw this._handleError(error, `Erro ao atualizar job ${jobId}`);
    }
  },

  /**
   * Deleta um job rascunho (draft) na Gupy
   *
   * DELETE /api/v1/jobs/{jobId}
   * IMPORTANTE: Só funciona para jobs com status "draft"
   *
   * @param {string|number} jobId - ID do job na Gupy
   * @returns {Promise<Object>} Resultado da deleção
   */
  async deleteDraftJob(jobId) {
    try {
      console.log(`[Gupy API] Deletando job draft ${jobId}`);

      const response = await gupyClient.delete(`/api/v1/jobs/${jobId}`);

      console.log(`[Gupy API] ✓ Job draft ${jobId} deletado com sucesso`);

      return response.data;
    } catch (error) {
      throw this._handleError(error, `Erro ao deletar job draft ${jobId}`);
    }
  },

  /**
   * Trata erros da API Gupy e retorna erro estruturado
   *
   * @private
   * @param {Error} error - Erro original
   * @param {string} message - Mensagem customizada
   * @returns {Error} Erro estruturado
   */
  _handleError(error, message) {
    const gupyError = new Error(message);

    if (error.response) {
      // Erro com resposta do servidor
      gupyError.status = error.response.status;
      gupyError.gupyData = error.response.data;

      // Mensagens específicas por status code
      switch (error.response.status) {
        case 401:
          gupyError.message = 'Autenticação falhou. Verifique GUPY_API_KEY.';
          break;
        case 403:
          gupyError.message = 'Acesso negado pela API Gupy.';
          break;
        case 404:
          gupyError.message = 'Recurso não encontrado na Gupy.';
          break;
        case 429:
          gupyError.message = 'Rate limit da API Gupy excedido. Tente novamente mais tarde.';
          break;
        case 500:
        case 502:
        case 503:
          gupyError.message = 'Erro interno da API Gupy. Tente novamente mais tarde.';
          break;
        default:
          gupyError.message = `${message}: ${error.response.data?.message || error.message}`;
      }
    } else if (error.request) {
      // Erro sem resposta (timeout, network)
      gupyError.status = 503;
      gupyError.message = 'API Gupy não respondeu. Verifique a conectividade.';
    } else {
      // Erro na configuração da requisição
      gupyError.status = 500;
      gupyError.message = message;
    }

    return gupyError;
  },

  /**
   * Lista career pages disponíveis
   * GET /api/v1/career-pages
   *
   * @returns {Promise<Array>} Lista de career pages
   */
  async listCareerPages() {
    try {
      const response = await gupyClient.get('/api/v1/career-pages');
      return response.data;
    } catch (error) {
      throw this._handleError(error, 'Erro ao listar career pages');
    }
  },

  /**
   * Busca múltiplas vagas da Gupy por IDs e verifica consistência
   *
   * IMPORTANTE: A API da Gupy NÃO suporta múltiplos ?id= na mesma request.
   * Quando enviamos ?id=123&id=456, ela ignora os IDs e retorna os primeiros 100 jobs.
   *
   * Solução: Fazer requests individuais para cada job ID, processando em lotes paralelos.
   *
   * @param {Array<string>} jobIds - Array de IDs das vagas na Gupy
   * @returns {Promise<Object>} Mapa { jobId: { status, exists_in_gupy, name } }
   */
  async getJobsStatus(jobIds) {
    try {
      if (!jobIds || jobIds.length === 0) {
        return {};
      }

      console.log(`[Gupy API] Buscando status de ${jobIds.length} vagas (requests individuais)...`);

      const jobsMap = {};
      const BATCH_SIZE = 5; // Processar 5 jobs em paralelo por vez

      // Processar em lotes para evitar sobrecarregar a API
      for (let i = 0; i < jobIds.length; i += BATCH_SIZE) {
        const batch = jobIds.slice(i, i + BATCH_SIZE);
        console.log(`[Gupy API] Processando lote ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(jobIds.length / BATCH_SIZE)}: IDs ${batch.join(', ')}`);

        // Fazer requests individuais em paralelo para este lote
        const promises = batch.map(async (jobId) => {
          try {
            const response = await gupyClient.get(`/api/v1/jobs?id=${jobId}&fields=id,status,name`);

            const results = response.data?.results || [];

            if (results.length > 0 && results[0].id) {
              const job = results[0];
              const jobIdStr = String(job.id);

              console.log(`[Gupy API] ✓ Job ${jobIdStr}: status="${job.status}", name="${job.name?.substring(0, 40)}..."`);

              return {
                id: jobIdStr,
                data: {
                  status: job.status || 'draft',
                  exists_in_gupy: true,
                  name: job.name || null,
                }
              };
            } else {
              console.warn(`[Gupy API] ✗ Job ${jobId}: NÃO ENCONTRADO na Gupy`);
              return {
                id: String(jobId),
                data: {
                  status: 'deleted',
                  exists_in_gupy: false,
                  name: null,
                }
              };
            }
          } catch (error) {
            const status = error.response?.status;

            // 404 = job genuinely does not exist in Gupy
            if (status === 404) {
              console.warn(`[Gupy API] ✗ Job ${jobId}: NÃO ENCONTRADO (404)`);
              return {
                id: String(jobId),
                data: {
                  status: 'deleted',
                  exists_in_gupy: false,
                  name: null,
                }
              };
            }

            // Other errors (500, 429, timeout) - mark as unknown, don't assume deleted
            console.error(`[Gupy API] ✗ Erro ao buscar job ${jobId}: ${error.message} (status: ${status || 'N/A'})`);
            return {
              id: String(jobId),
              data: {
                status: 'unknown',
                exists_in_gupy: null, // null = we don't know
                name: null,
                error: error.message,
              }
            };
          }
        });

        // Aguardar conclusão do lote
        const results = await Promise.all(promises);

        // Adicionar resultados ao mapa
        results.forEach(({ id, data }) => {
          jobsMap[id] = data;
        });
      }

      const foundCount = Object.values(jobsMap).filter(j => j.exists_in_gupy).length;
      const deletedCount = Object.values(jobsMap).filter(j => !j.exists_in_gupy).length;

      console.log(`[Gupy API] ✓ Concluído: ${foundCount} vagas encontradas, ${deletedCount} não encontradas (excluídas)`);

      return jobsMap;
    } catch (error) {
      // Propagate error - caller should handle API failures explicitly
      // Do NOT return fallback that assumes jobs exist
      console.error('[Gupy API] Erro crítico ao buscar status das vagas:', error.message);
      throw this._handleError(error, 'Erro ao buscar status das vagas');
    }
  },

  /**
   * Verifica se o serviço está configurado corretamente
   *
   * @returns {boolean} true se configurado
   */
  isConfigured() {
    return !!GUPY_API_KEY;
  },

  /**
   * Testa a conexão com a API Gupy
   *
   * @returns {Promise<boolean>} true se conectado
   */
  async testConnection() {
    try {
      await this.listJobTemplates();
      return true;
    } catch (error) {
      console.error('[Gupy API] Falha no teste de conexão:', error.message);
      return false;
    }
  },

  // ===================================================================
  // CANDIDATE/APPLICATION FUNCTIONS (merged from gupyApi.js)
  // ===================================================================

  /**
   * Fetch application (candidate) data from Gupy API
   * Used for Zero PII - fetch candidate data on-demand
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @returns {Promise<object>} Candidate data { id, name, email, cpf, phone }
   * @throws {Error} If candidate not found or API error
   */
  async getApplicationByJob(jobId, applicationId) {
    return this._withRetry('getApplicationByJob', async () => {
      const url = `/api/v1/jobs/${jobId}/applications?id=${applicationId}`;

      const response = await gupyClient.get(url);
      const applications = response.data?.results || [];

      const application = applications.find(app => app.id === parseInt(applicationId));

      if (!application) {
        throw new Error('Candidato não encontrado na Gupy');
      }

      const candidate = application.candidate || {};

      return {
        id: application.id,
        candidateId: candidate.id ? String(candidate.id) : null,
        name: `${candidate.name || ''} ${candidate.lastName || ''}`.trim() || 'Nome não disponível',
        email: candidate.email || '',
        cpf: candidate.identificationDocument || '',
        phone: candidate.mobileNumber || candidate.phoneNumber || '',
        current_step: application.currentStep?.name || null,
      };
    });
  },

  /**
   * Get only the candidate ID from Gupy API v1
   * Uses fields parameter for minimal payload
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @returns {Promise<string|null>} Candidate ID or null if not found
   */
  async getCandidateIdFromApplication(jobId, applicationId) {
    try {
      const url = `/api/v1/jobs/${jobId}/applications?id=${applicationId}&fields=id,candidate.id`;
      const response = await gupyClient.get(url);
      const applications = response.data?.results || [];
      const application = applications.find(app => app.id === parseInt(applicationId));

      if (!application?.candidate?.id) {
        console.warn(`[Gupy] Candidate ID not found for application ${applicationId}`);
        return null;
      }

      return String(application.candidate.id);
    } catch (error) {
      console.error(`[Gupy] Failed to get candidate ID for app ${applicationId}:`, error.message);
      return null;
    }
  },

  /**
   * Fetch multiple candidate data in batch (for Zero PII enrichment)
   *
   * @param {Array<{jobId: string, applicationId: string}>} applications - Array of job/application pairs
   * @returns {Promise<Map<string, {name, email, cpf, phone}>>} Map of applicationId -> candidate data
   */
  async getApplicationsBatch(applications) {
    const results = new Map();
    const BATCH_SIZE = 5;

    for (let i = 0; i < applications.length; i += BATCH_SIZE) {
      const batch = applications.slice(i, i + BATCH_SIZE);

      const promises = batch.map(async ({ jobId, applicationId }) => {
        try {
          const data = await this.getApplicationByJob(jobId, applicationId);
          return { applicationId, data };
        } catch (error) {
          console.error(`[Gupy Batch] Failed for app ${applicationId}:`, error.message);
          return { applicationId, data: null };
        }
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach(({ applicationId, data }) => {
        if (data) {
          results.set(applicationId, {
            name: data.name,
            email: data.email,
            cpf: data.cpf,
            phone: data.phone
          });
        }
      });
    }

    return results;
  },

  /**
   * Fetch application currentStep from Gupy
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @returns {Promise<object>} Application data with currentStep
   */
  async getApplicationCurrentStep(jobId, applicationId) {
    return this._withRetry('getApplicationCurrentStep', async () => {
      const url = `/api/v1/jobs/${jobId}/applications?id=${applicationId}&fields=currentStep.name`;

      const response = await gupyClient.get(url);
      const applications = response.data?.results || [];

      if (applications.length === 0) {
        throw new Error('Candidato não encontrado na Gupy');
      }

      return {
        currentStep: applications[0].currentStep || null,
      };
    });
  },

  /**
   * Get step ID by step name
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} stepName - Step name (e.g., "Aprovado no Processo")
   * @returns {Promise<string|null>} Step ID if found, null otherwise
   */
  async getJobStepId(jobId, stepName) {
    return this._withRetry('getJobStepId', async () => {
      const response = await gupyClient.get(`/api/v1/jobs/${jobId}/steps`);
      const steps = response.data?.results || [];

      console.log(`[Gupy API] Found ${steps.length} steps for job ${jobId}`);

      const step = steps.find(s => s.name === stepName);

      if (step) {
        console.log(`[Gupy API] Step "${stepName}" found with ID: ${step.id}`);
        return step.id;
      } else {
        const availableSteps = steps.map(s => s.name).join(', ');
        console.log(`[Gupy API] Step "${stepName}" not found. Available: ${availableSteps}`);
        return null;
      }
    });
  },

  /**
   * List all steps for a job
   *
   * @param {string} jobId - Gupy job ID
   * @returns {Promise<Array>} Array of step objects { id, name, type }
   */
  async listJobSteps(jobId) {
    return this._withRetry('listJobSteps', async () => {
      const response = await gupyClient.get(`/api/v1/jobs/${jobId}/steps`);
      const steps = response.data?.results || [];

      console.log(`[Gupy API] Found ${steps.length} steps for job ${jobId}`);

      return steps.map(step => ({
        id: step.id,
        name: step.name,
        type: step.type || null,
      }));
    });
  },

  /**
   * Move application to a different step in Gupy
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @param {string} stepNameOrStepId - Step name or ID
   * @returns {Promise<object>} Updated application data
   */
  async moveApplication(jobId, applicationId, stepNameOrStepId) {
    let stepId = stepNameOrStepId;

    // If it looks like a step name, resolve to ID
    if (/\s/.test(stepNameOrStepId) || isNaN(stepNameOrStepId)) {
      console.log(`[Gupy API] Resolving step name "${stepNameOrStepId}" to ID`);
      stepId = await this.getJobStepId(jobId, stepNameOrStepId);

      if (!stepId) {
        throw new Error(`Step "${stepNameOrStepId}" não encontrado no job`);
      }
    }

    return this._withRetry('moveApplication', async () => {
      const response = await gupyClient.patch(
        `/api/v1/jobs/${jobId}/applications/${applicationId}`,
        { currentStepId: stepId }
      );
      return response.data;
    });
  },

  /**
   * Search applications across ALL active jobs by CPF
   * Used for candidate lookup without knowing which job they applied to
   *
   * @param {string} cpf - Candidate CPF (only digits, 11 chars)
   * @param {string|null} email - Optional email to validate against
   * @param {object} db - Database connection (passed from route)
   * @returns {Promise<Array>} Array of applications with job info
   */
  async searchApplicationsByCpf(cpf, email = null, db) {
    try {
      // 1. Get all active jobs from database
      const jobsResult = await db.query(
        `SELECT id_job_gupy, job_name FROM job_subregional WHERE ativo = true`
      );
      const jobs = jobsResult.rows;

      if (jobs.length === 0) {
        console.log('[Gupy API] No active jobs found in database');
        return [];
      }

      console.log(`[Gupy API] Searching ${jobs.length} active jobs for CPF ${cpf.substring(0, 3)}***`);

      // 2. Search each job in parallel (batch of 5)
      const BATCH_SIZE = 5;
      const allApplications = [];

      for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batch = jobs.slice(i, i + BATCH_SIZE);

        const promises = batch.map(async (job) => {
          try {
            const apps = await this.searchApplicationsByJobAndCpf(job.id_job_gupy, cpf, null);
            // Enrich with local job info
            return apps.map(app => ({
              ...app,
              job_name: job.job_name || app.job_name,
              id_job_gupy: job.id_job_gupy,
            }));
          } catch (error) {
            console.error(`[Gupy API] Error searching job ${job.id_job_gupy}:`, error.message);
            return [];
          }
        });

        const batchResults = await Promise.all(promises);
        batchResults.forEach(apps => allApplications.push(...apps));
      }

      // 3. If email provided, filter by email match
      let filteredApplications = allApplications;
      if (email) {
        filteredApplications = allApplications.filter(
          app => app.candidate_email?.toLowerCase() === email.toLowerCase()
        );

        if (filteredApplications.length === 0 && allApplications.length > 0) {
          // CPF found but email doesn't match
          console.log(`[Gupy API] CPF found but email mismatch`);
          return { error: 'email_mismatch', applications: [] };
        }
      }

      console.log(`[Gupy API] Found ${filteredApplications.length} applications for CPF`);

      return filteredApplications;
    } catch (error) {
      console.error('[Gupy API] Error in searchApplicationsByCpf:', error.message);
      throw error;
    }
  },

  /**
   * Search applications in a specific job by CPF and optionally by step
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} cpf - Candidate CPF (only digits)
   * @param {string|null} stepName - Current step name (e.g., "Aula Teste") or null for all steps
   * @returns {Promise<Array>} Array of applications matching criteria
   */
  async searchApplicationsByJobAndCpf(jobId, cpf, stepName = null) {
    try {
      const params = new URLSearchParams();
      if (stepName) {
        params.append('currentStep.name', stepName);
      }
      params.append('candidate.identificationDocument', cpf);

      const url = `/api/v1/jobs/${jobId}/applications?${params.toString()}`;

      const cpfMasked = cpf ? `${cpf.substring(0, 3)}***` : '***';
      console.log(`[Gupy API] Searching job ${jobId} for CPF ${cpfMasked}${stepName ? ` at step "${stepName}"` : ' (all steps)'}`);

      const response = await gupyClient.get(url);
      const applications = response.data?.results || [];

      console.log(`[Gupy API] Found ${applications.length} applications in job ${jobId}`);

      return applications.map(app => ({
        id_application: app.id,
        candidate_name: `${app.candidate?.name || ''} ${app.candidate?.lastName || ''}`.trim() || 'Nome não disponível',
        candidate_email: app.candidate?.email || '',
        candidate_cpf: app.candidate?.identificationDocument || '',
        candidate_phone: app.candidate?.mobileNumber || app.candidate?.phoneNumber || '',
        current_step: app.currentStep?.name || '',
        job_id: jobId,
        job_name: app.job?.name || '',
      }));
    } catch (error) {
      // Propagate error - caller must distinguish "no results" from "search failed"
      console.error(`[Gupy API] Error searching job ${jobId}:`, error.message);
      throw this._handleError(error, `Erro ao buscar applications no job ${jobId}`);
    }
  },

  // ===================================================================
  // TAG AND COMMENT FUNCTIONS (Sprint 2 - Fiscalização)
  // ===================================================================

  /**
   * Add a tag to an application in Gupy
   * POST /api/v1/jobs/{jobId}/applications/{applicationId}/tags
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @param {string} tagName - Tag name to add (e.g., "ausente-prova-online", "Investigar", "Eliminado")
   * @returns {Promise<object>} Response from Gupy API
   */
  async addTag(jobId, applicationId, tagName) {
    return this._withRetry('addTag', async () => {
      console.log(`[Gupy API] Adding tag "${tagName}" to application ${applicationId} in job ${jobId}`);

      // Gupy API uses PUT for adding tags, not POST
      const response = await gupyClient.put(
        `/api/v1/jobs/${jobId}/applications/${applicationId}/tags`,
        { name: tagName }
      );

      console.log(`[Gupy API] ✓ Tag "${tagName}" added successfully`);

      return response.data;
    });
  },

  /**
   * Remove a tag from an application in Gupy
   * DELETE /api/v1/jobs/{jobId}/applications/{applicationId}/tags?name={tagName}
   *
   * Note: Gupy API expects tag name as query parameter, not in request body.
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @param {string} tagName - Tag name to remove
   * @returns {Promise<object>} Response from Gupy API
   */
  async removeTag(jobId, applicationId, tagName) {
    return this._withRetry('removeTag', async () => {
      console.log(`[Gupy API] Removing tag "${tagName}" from application ${applicationId} in job ${jobId}`);

      try {
        // Gupy API expects tag name as query parameter, not body
        // DELETE /api/v1/jobs/{jobId}/applications/{applicationId}/tags?name={tagName}
        const response = await gupyClient.delete(
          `/api/v1/jobs/${jobId}/applications/${applicationId}/tags`,
          { params: { name: tagName } }
        );

        console.log(`[Gupy API] ✓ Tag "${tagName}" removed successfully`);

        return response.data;
      } catch (error) {
        console.error(`[Gupy API] ✗ Failed to remove tag "${tagName}":`, {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          message: error.message,
        });
        throw error;
      }
    });
  },

  /**
   * Add a comment to an application timeline in Gupy
   * POST /api/v1/jobs/{jobId}/applications/{applicationId}/comments
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @param {string} text - Comment text to add to timeline
   * @returns {Promise<object>} Response from Gupy API
   */
  async addTimelineComment(jobId, applicationId, text) {
    return this._withRetry('addTimelineComment', async () => {
      console.log(`[Gupy API] Adding comment to application ${applicationId} in job ${jobId}`);

      const response = await gupyClient.post(
        `/api/v1/jobs/${jobId}/applications/${applicationId}/comments`,
        { text }
      );

      console.log(`[Gupy API] ✓ Comment added successfully`);

      return response.data;
    });
  },

  /**
   * Reprove an application in Gupy
   * PATCH /api/v1/jobs/{jobId}/applications/{applicationId}
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @param {string} reason - Disapproval reason (from Gupy enum)
   * @param {string} notes - Additional notes for disapproval
   * @returns {Promise<object>} Response from Gupy API
   */
  async reproveApplication(jobId, applicationId, reason, notes) {
    return this._withRetry('reproveApplication', async () => {
      console.log(`[Gupy API] Reproving application ${applicationId} in job ${jobId} with reason: ${reason}`);

      const response = await gupyClient.patch(
        `/api/v1/jobs/${jobId}/applications/${applicationId}`,
        {
          status: 'reproved',
          disapprovalReason: reason,
          disapprovalReasonNotes: notes || '',
        }
      );

      console.log(`[Gupy API] ✓ Application ${applicationId} reproved successfully`);

      return response.data;
    });
  },

  /**
   * Undo reproval of an application in Gupy (reactivate to in_process)
   * PATCH /api/v1/jobs/{jobId}/applications/{applicationId}
   *
   * @param {string} jobId - Gupy job ID
   * @param {string} applicationId - Gupy application ID
   * @returns {Promise<object>} Response from Gupy API
   */
  async undoReproval(jobId, applicationId) {
    return this._withRetry('undoReproval', async () => {
      console.log(`[Gupy API] Undoing reproval for application ${applicationId} in job ${jobId}`);

      const response = await gupyClient.patch(
        `/api/v1/jobs/${jobId}/applications/${applicationId}`,
        {
          status: 'in_process',
          disapprovalReason: 'other_reason',
          disapprovalReasonNotes: 'undo reproval',
        }
      );

      console.log(`[Gupy API] ✓ Application ${applicationId} reproval undone successfully`);

      return response.data;
    });
  },

  /**
   * Fetch complete candidate profile by Gupy candidate ID.
   * Returns education, experience, languages, contact info, etc.
   *
   * @param {string} candidateId - Gupy candidate ID
   * @returns {Promise<Object>} Full candidate profile
   */
  async fetchCandidateById(candidateId) {
    if (!candidateId) {
      throw new Error('candidateId is required');
    }

    return this._withRetry('fetchCandidateById', async () => {
      console.log(`[Gupy API] Fetching candidate profile: ${candidateId}`);

      // Use query param format: /api/v2/candidates?ids=123
      const response = await gupyClient.get('/api/v2/candidates', {
        params: { ids: candidateId }
      });

      const candidates = response.data?.results || [];
      if (candidates.length === 0) {
        throw new Error(`Candidate ${candidateId} not found in Gupy`);
      }

      console.log(`[Gupy API] ✓ Candidate ${candidateId} fetched successfully`);
      return candidates[0];
    });
  },

  // ===================================================================
  // RETRY LOGIC WITH ERROR LOGGING
  // ===================================================================

  /**
   * Execute a function with retry logic and error logging
   *
   * @private
   * @param {string} operation - Operation name for logging
   * @param {Function} fn - Async function to execute
   * @param {number} maxRetries - Maximum retry attempts (default: 3)
   * @returns {Promise<any>} Result from fn
   */
  async _withRetry(operation, fn, maxRetries = 3) {
    const { logApiError } = require('../lib/errorLogger');
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Check if error is retryable (5xx, 429, network errors)
        const status = error.response?.status;
        const isRetryable = [429, 500, 502, 503, 504].includes(status) ||
                           error.code === 'ECONNABORTED' ||
                           error.code === 'ETIMEDOUT';

        if (!isRetryable || attempt === maxRetries - 1) {
          // Log error to database
          await logApiError('gupy', operation, error, {
            url: error.config?.url,
            response: error.response?.data,
          });
          throw error;
        }

        // Exponential backoff
        const delay = 1000 * Math.pow(2, attempt);
        console.log(`[Gupy API] Retry ${attempt + 1}/${maxRetries} for ${operation} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastError;
  },

  // ===================================================================
  // EMAIL TEMPLATE FUNCTIONS (Gestao de Candidaturas - Mass Actions)
  // ===================================================================

  /**
   * List email templates from Gupy API v1
   * GET /api/v1/email-templates
   *
   * @param {Object} options - Options
   * @param {number} [options.perPage] - Results per page (default: 100)
   * @param {number} [options.page] - Page number (default: 1)
   * @returns {Promise<Array>} List of email templates
   */
  async listEmailTemplates(options = {}) {
    return this._withRetry('listEmailTemplates', async () => {
      const { perPage = 100, page = 1 } = options;

      console.log('[Gupy API] Fetching email templates from v1...');

      const response = await gupyClient.get('/api/v1/email-templates', {
        params: { perPage, page },
      });

      if (!response.data) {
        throw new Error('Gupy API returned empty response for email templates');
      }

      // v1 API may return results in 'results' array or directly as array
      const templates = response.data?.results || response.data;
      if (!Array.isArray(templates)) {
        throw new Error('Gupy API returned invalid format for email templates');
      }

      console.log(`[Gupy API] ✓ Found ${templates.length} email templates`);

      return templates;
    });
  },

  /**
   * Get a specific email template by ID
   * GET /api/v1/email-templates/{templateId}
   *
   * @param {string|number} templateId - Template ID
   * @returns {Promise<Object>} Email template details
   */
  async getEmailTemplate(templateId) {
    return this._withRetry('getEmailTemplate', async () => {
      console.log(`[Gupy API] Fetching email template ${templateId}...`);

      const response = await gupyClient.get(`/api/v1/email-templates/${templateId}`);

      if (!response.data || !response.data.id) {
        throw new Error(`Template ${templateId} not found or invalid response`);
      }

      console.log(`[Gupy API] ✓ Template ${templateId} fetched`);

      return response.data;
    });
  },

  /**
   * Send email to an application using a template
   * POST /api/v1/jobs/{jobId}/applications/{applicationId}/messages
   *
   * @param {Object} params - Send params
   * @param {string|number} params.jobId - Gupy job ID
   * @param {string|number} params.applicationId - Gupy application ID
   * @param {string|number} params.templateId - Email template ID
   * @param {Object} [params.variables] - Template variables (optional)
   * @param {boolean} [params.allowReply=false] - Whether recipient can reply to the email (default: false)
   * @param {string} [params.from='recrutamento@tomeducacao.com.br'] - Sender email address
   * @returns {Promise<Object>} Send result
   */
  async sendEmailToApplication(params) {
    return this._withRetry('sendEmailToApplication', async () => {
      const {
        jobId,
        applicationId,
        templateId,
        variables = {},
        allowReply = false,
        from = 'recrutamento@tomeducacao.com.br',
      } = params;

      if (!jobId) {
        throw new Error('jobId is required to send email');
      }

      console.log(`[Gupy API] Sending email to application ${applicationId} (job ${jobId}) using template ${templateId}...`);

      const payload = {
        templateId: Number(templateId),
        allowReply,
        from,
      };

      // Add variables if provided
      if (Object.keys(variables).length > 0) {
        payload.variables = variables;
      }

      const response = await gupyClient.post(
        `/api/v1/jobs/${jobId}/applications/${applicationId}/messages`,
        payload
      );

      console.log(`[Gupy API] ✓ Email sent to application ${applicationId}`);

      return response.data;
    });
  },

  /**
   * Send email to multiple applications using a template (batch)
   * Processes in parallel batches with rate limiting.
   *
   * Rate limiting: 200ms delay between batches to avoid Gupy API rate limits.
   * Expected throughput: ~25 emails/second with default batchSize of 5.
   *
   * @param {Object} params - Send params
   * @param {Array<{jobId: string|number, applicationId: string|number}>} params.applications - Array of {jobId, applicationId} objects
   * @param {string|number} params.templateId - Email template ID
   * @param {Object} [params.variables] - Template variables (optional)
   * @param {number} [params.batchSize=5] - Parallel batch size (default: 5)
   * @returns {Promise<Object>} Batch result { sent, failed, errors }
   */
  async sendEmailBatch(params) {
    const { applications, templateId, variables = {}, batchSize = 5 } = params;

    console.log(`[Gupy API] Starting batch email send: ${applications.length} applications, template ${templateId}`);

    const results = {
      sent: 0,
      failed: 0,
      errors: [],
    };

    // Process in batches
    for (let i = 0; i < applications.length; i += batchSize) {
      const batch = applications.slice(i, i + batchSize);

      console.log(`[Gupy API] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(applications.length / batchSize)}`);

      const promises = batch.map(async ({ jobId, applicationId }) => {
        try {
          await this.sendEmailToApplication({ jobId, applicationId, templateId, variables });
          return { applicationId, success: true };
        } catch (error) {
          const errorDetail = {
            applicationId,
            success: false,
            error: error.message,
            status: error.response?.status,
            gupyError: error.response?.data?.message || error.response?.data?.error,
          };
          console.error(`[Gupy API] Failed to send email to ${applicationId}:`, errorDetail);
          return errorDetail;
        }
      });

      const batchResults = await Promise.all(promises);

      batchResults.forEach((result) => {
        if (result.success) {
          results.sent++;
        } else {
          results.failed++;
          results.errors.push({ applicationId: result.applicationId, error: result.error });
        }
      });

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < applications.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    console.log(`[Gupy API] ✓ Batch complete: ${results.sent} sent, ${results.failed} failed`);

    return results;
  },

  /**
   * Fetch applications by IDs from Gupy API v2
   * Used by applicationSync for batch fetching with currentStep expansion
   *
   * @param {(string|number)[]} applicationIds - Array of Gupy application IDs
   * @returns {Promise<Object[]>} Array of application objects with currentStep
   */
  async fetchApplicationsByIds(applicationIds) {
    if (!applicationIds || applicationIds.length === 0) {
      return [];
    }

    return this._withRetry('fetchApplicationsByIds', async () => {
      const idsParam = applicationIds.join(',');
      const response = await gupyClient.get('/api/v2/applications', {
        params: {
          applicationId: idsParam,
          expand: 'currentStep',
          maxPageSize: 100,
        }
      });

      if (!response.data?.results) {
        throw new Error('Gupy API returned invalid response for applications');
      }

      return response.data.results;
    });
  },

  /**
   * Fetch applications by IDs from Gupy API v2 with candidate expansion
   * Used for syncing candidate IDs
   *
   * @param {(string|number)[]} applicationIds - Array of Gupy application IDs
   * @returns {Promise<Object[]>} Array of application objects with candidate data
   */
  async fetchApplicationsWithCandidate(applicationIds) {
    if (!applicationIds || applicationIds.length === 0) {
      return [];
    }

    return this._withRetry('fetchApplicationsWithCandidate', async () => {
      const idsParam = applicationIds.join(',');
      const response = await gupyClient.get('/api/v2/applications', {
        params: {
          applicationId: idsParam,
          expand: 'candidate',
          maxPageSize: 100,
        }
      });

      if (!response.data?.results) {
        throw new Error('Gupy API returned invalid response for applications');
      }

      return response.data.results;
    });
  },

  /**
   * Update hiring information for an application
   * Called after moving candidate to "Contratação" step
   *
   * @param {string|number} jobId - Gupy job ID
   * @param {string|number} applicationId - Gupy application ID
   * @param {Object} hiringData - Hiring information
   * @param {string} hiringData.hiringType - 'employee_admission' or 'contractor'
   * @param {string} hiringData.hiringDate - ISO 8601 date string
   * @param {number} hiringData.salary - Salary value
   * @param {string} hiringData.salaryCurrencyType - Currency type ('R$')
   * @returns {Promise<Object>} Updated application data
   */
  async updateHiringInformation(jobId, applicationId, hiringData) {
    console.log('[GupyService] Updating hiring information:', {
      jobId,
      applicationId,
      hiringType: hiringData.hiringType,
      hiringDate: hiringData.hiringDate,
      salary: hiringData.salary
    });

    return this._withRetry('updateHiringInformation', async () => {
      const payload = {
        hiringType: hiringData.hiringType || 'employee_admission',
        hiringDate: hiringData.hiringDate,
        jobVacancyCodeId: hiringData.jobVacancyCodeId || null,
        salary: hiringData.salary,
        salaryCurrencyType: hiringData.salaryCurrencyType || 'R$'
      };

      const response = await gupyClient.patch(
        `/api/v1/jobs/${jobId}/applications/${applicationId}/hiring-information`,
        payload
      );

      console.log('[GupyService] Hiring information updated successfully');
      return response.data;
    });
  },
};

module.exports = gupyService;
