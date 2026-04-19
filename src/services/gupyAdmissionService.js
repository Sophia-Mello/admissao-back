/**
 * Gupy Admissão API Service
 *
 * Serviço para integração com a API da Gupy Admissão
 * Documentação: https://developers.gupy.io/reference/admission
 *
 * Autenticação:
 * - POST /api/v1/auth/token com clientId e secret
 * - Token válido por 7 dias (604800 segundos)
 * - Renovação automática quando faltar menos de 1 dia
 */

const axios = require('axios');

// Configuração da API Gupy Admissão
const GUPY_ADMISSION_API_URL = process.env.GUPY_ADMISSION_API_URL || 'https://admission.app.gupy.io';
const GUPY_ADMISSION_CLIENT_ID = process.env.GUPY_ADMISSION_CLIENT_ID;
const GUPY_ADMISSION_SECRET = process.env.GUPY_ADMISSION_SECRET;

// Token em memória (renovado automaticamente)
let accessToken = null;
let tokenExpiresAt = null;

// Tempo mínimo antes de expirar para renovar (1 dia em ms)
const TOKEN_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Step IDs conhecidos da Gupy Admissão
const ADMISSION_STEPS = {
  PENDING: 'PENDING',                                    // Admissão não iniciada
  INVITED: 'INVITED',                                    // Convite enviado
  SEND_DOCUMENTS: 'SEND_DOCUMENTS',                      // Envio de documentação
  DADOS_SALU: 'dbd1f1e6-731a-4198-9471-d64de89af54e',   // Dados a Enviar Para Salú
  PRONTO_SENIOR: 'b87034c3-12aa-4818-9b8c-6ee84a79fb10', // Pronto Para Cadastro no Sênior
  EM_PROCESSO: 'e38117a9-7989-488b-a2b4-45c8ddb7c8ee',   // Em Processo de Cadastro
  SIGNING_CONTRACT: 'SIGNING_CONTRACT',                  // Assinatura de contrato
  ADMISSION_CONCLUDED: 'ADMISSION_CONCLUDED',            // Admissão concluída
  OUT_PROCESS: 'OUT_PROCESS'                             // Fora do processo
};

/**
 * Cliente HTTP para Gupy Admissão (criado após obter token)
 */
let gupyAdmissionClient = null;

/**
 * Cria/atualiza o cliente HTTP com o token atual
 */
function createClient(token) {
  gupyAdmissionClient = axios.create({
    baseURL: GUPY_ADMISSION_API_URL,
    timeout: 30000,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  // Interceptor para logging
  gupyAdmissionClient.interceptors.request.use(
    (config) => {
      console.log(`[Gupy Admissão API] ${config.method.toUpperCase()} ${config.url}`);
      return config;
    },
    (error) => {
      console.error('[Gupy Admissão API] Erro na requisição:', error.message);
      return Promise.reject(error);
    }
  );

  gupyAdmissionClient.interceptors.response.use(
    (response) => {
      console.log(`[Gupy Admissão API] ✓ ${response.status}`);
      return response;
    },
    (error) => {
      if (error.response) {
        console.error(`[Gupy Admissão API] ✗ ${error.response.status}:`, error.response.data);
      } else {
        console.error('[Gupy Admissão API] Erro:', error.message);
      }
      return Promise.reject(error);
    }
  );
}

/**
 * Serviço da Gupy Admissão API
 */
const gupyAdmissionService = {
  /**
   * Verifica se o serviço está configurado
   * @returns {boolean}
   */
  isConfigured() {
    return !!(GUPY_ADMISSION_CLIENT_ID && GUPY_ADMISSION_SECRET);
  },

  /**
   * Renova o token de acesso
   * POST /api/v1/auth/token
   *
   * @returns {Promise<string>} Access token
   */
  async refreshToken() {
    if (!this.isConfigured()) {
      throw new Error('GUPY_ADMISSION_CLIENT_ID e GUPY_ADMISSION_SECRET não configurados');
    }

    console.log('[Gupy Admissão API] Renovando token...');

    try {
      const response = await axios.post(`${GUPY_ADMISSION_API_URL}/api/v1/auth/token`, {
        clientId: GUPY_ADMISSION_CLIENT_ID,
        secret: GUPY_ADMISSION_SECRET
      }, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.data?.accessToken) {
        throw new Error('Resposta inválida da API de autenticação');
      }

      accessToken = response.data.accessToken;
      // expiresIn em segundos, converter para timestamp
      const expiresInMs = (response.data.expiresIn || 604800) * 1000;
      tokenExpiresAt = Date.now() + expiresInMs;

      // Criar/atualizar cliente com novo token
      createClient(accessToken);

      console.log('[Gupy Admissão API] ✓ Token renovado, expira em:', new Date(tokenExpiresAt).toISOString());

      return accessToken;
    } catch (error) {
      console.error('[Gupy Admissão API] Erro ao renovar token:', error.message);
      throw new Error(`Falha na autenticação Gupy Admissão: ${error.message}`);
    }
  },

  /**
   * Obtém token válido (renova se necessário)
   *
   * @returns {Promise<string>} Access token válido
   */
  async getToken() {
    // Se não tem token ou está próximo de expirar, renovar
    if (!accessToken || !tokenExpiresAt || Date.now() >= tokenExpiresAt - TOKEN_REFRESH_THRESHOLD_MS) {
      await this.refreshToken();
    }
    return accessToken;
  },

  /**
   * Move um pré-funcionário para uma nova etapa na Gupy Admissão
   *
   * PATCH /api/v1/pre-employees/workflow-steps
   *
   * @param {string} idAdmission - ID do pré-funcionário na Gupy Admissão
   * @param {string} newStepId - ID da nova etapa (usar ADMISSION_STEPS)
   * @param {string} [currentStepId] - ID da etapa atual (opcional, para validação)
   * @returns {Promise<Object>} Resposta da API
   */
  async moveAdmissionStep(idAdmission, newStepId, currentStepId = null) {
    if (!idAdmission) {
      throw new Error('idAdmission é obrigatório');
    }
    if (!newStepId) {
      throw new Error('newStepId é obrigatório');
    }

    // Garantir token válido
    await this.getToken();

    console.log('[Gupy Admissão API] Movendo pré-funcionário:', {
      idAdmission,
      newStepId,
      currentStepId: currentStepId || '(não especificado)'
    });

    try {
      const payload = {
        ids: [Number(idAdmission)],  // API Gupy espera número
        newWorkflowStep: newStepId
      };

      // Adicionar currentWorkflowStep se fornecido
      if (currentStepId) {
        payload.currentWorkflowStep = currentStepId;
      }

      const response = await gupyAdmissionClient.patch('/api/v1/pre-employees/workflow-steps', payload);

      console.log('[Gupy Admissão API] ✓ Pré-funcionário movido para:', newStepId);

      return response.data;
    } catch (error) {
      // Se erro 401, tentar renovar token e repetir
      if (error.response?.status === 401) {
        console.log('[Gupy Admissão API] Token expirado, renovando...');
        await this.refreshToken();

        const payload = {
          ids: [Number(idAdmission)],  // API Gupy espera número
          newWorkflowStep: newStepId
        };
        if (currentStepId) {
          payload.currentWorkflowStep = currentStepId;
        }

        const response = await gupyAdmissionClient.patch('/api/v1/pre-employees/workflow-steps', payload);
        return response.data;
      }

      console.error('[Gupy Admissão API] Erro ao mover pré-funcionário:', {
        idAdmission,
        newStepId,
        status: error.response?.status,
        error: error.response?.data || error.message
      });

      throw new Error(`Erro ao mover pré-funcionário na Gupy Admissão: ${error.response?.data?.message || error.message}`);
    }
  },

  /**
   * Move pré-funcionário para "Pronto Para Cadastro no Sênior"
   * Atalho para moveAdmissionStep com step PRONTO_SENIOR
   *
   * @param {string} idAdmission - ID do pré-funcionário
   * @returns {Promise<Object>} Resposta da API
   */
  async moveToProntoSenior(idAdmission) {
    return this.moveAdmissionStep(
      idAdmission,
      ADMISSION_STEPS.PRONTO_SENIOR,
      ADMISSION_STEPS.DADOS_SALU // etapa anterior esperada
    );
  },

  /**
   * Testa a conexão com a API
   *
   * @returns {Promise<boolean>} true se conectado
   */
  async testConnection() {
    try {
      await this.getToken();
      return true;
    } catch (error) {
      console.error('[Gupy Admissão API] Falha no teste de conexão:', error.message);
      return false;
    }
  },

  // Exportar constantes de steps
  ADMISSION_STEPS
};

module.exports = gupyAdmissionService;
