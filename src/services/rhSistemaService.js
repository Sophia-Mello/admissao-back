/**
 * Serviço de integração com RH Sistema
 *
 * Responsável por criar colaboradores via API do RH Sistema
 * Endpoint: POST https://api.rhsistema.com.br/api/v1/colaboradores
 *
 * Este endpoint cria registros em:
 * - colaborador (dados básicos)
 * - colaborador_materia (vínculo com matéria)
 */

const axios = require('axios');

// Constantes de tipo_vinculo do RH Sistema
const TIPO_VINCULO = {
  CANDIDATO_APROVADO: 50,         // Candidato aprovado no processo seletivo
  LIBERADO_PARA_ADMISSAO: 51,     // Liberado para admissão (diretor liberou)
  EM_ADMISSAO: 53,                // Em processo de admissão
  CLT: 47                          // CLT (após exame ocupacional)
};

// Configuração do cliente HTTP
const RH_SISTEMA_API_URL = process.env.RH_SISTEMA_API_URL || 'https://api.rhsistema.com.br';
const RH_SISTEMA_API_KEY = process.env.RH_SISTEMA_API_KEY;

const rhSistemaClient = axios.create({
  baseURL: RH_SISTEMA_API_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': RH_SISTEMA_API_KEY
  }
});

/**
 * Cria um colaborador no RH Sistema
 *
 * @param {Object} params
 * @param {string} params.nome - Nome completo
 * @param {string} params.cpf - CPF (11 dígitos)
 * @param {string} params.email - Email
 * @param {string} params.telefone - Telefone/Celular
 * @param {number} params.id_unidade - ID da unidade
 * @param {number[]} params.materias_selecionadas - Array de id_materia
 * @param {number} params.id_funcao - ID da função (default: 67 = Professor)
 * @returns {Object} { id_colaborador, success }
 */
async function criarColaborador({ nome, cpf, email, telefone, id_unidade, materias_selecionadas = [], id_funcao = 67 }) {
  // Mascara CPF no log para segurança
  const cpfMasked = cpf ? `${cpf.substring(0, 3)}.***.***-${cpf.slice(-2)}` : '***';
  console.log('[RHSistemaService] Criando colaborador:', { nome, cpf: cpfMasked, id_unidade, materias_selecionadas });

  if (!RH_SISTEMA_API_KEY) {
    throw new Error('RH_SISTEMA_API_KEY não configurada');
  }

  try {
    const payload = {
      nome,
      cpf,
      email,
      celular: telefone,                              // Telefone vai no campo celular
      telefone: null,                                  // Campo telefone separado (fixo)
      id_unidade,
      id_tipo_vinculo: TIPO_VINCULO.CANDIDATO_APROVADO,  // 50 - tipo_vinculo inicial
      professor_flag: true,
      coordenador_flag: false,
      carga_complementacao: 0,
      id_funcao,                                       // ID da função (vem da view funcao)
      matricula_erp_dp: null,
      materias_selecionadas                            // Array de id_materia
    };

    const response = await rhSistemaClient.post('/api/v1/colaboradores', payload);

    // API returns { success: true, data: { id_colaborador } } OR object directly
    if (response.data?.success && response.data?.data?.id_colaborador) {
      console.log('[RHSistemaService] Colaborador criado com sucesso:', response.data.data.id_colaborador);
      return {
        success: true,
        id_colaborador: response.data.data.id_colaborador
      };
    }

    // API returns colaborador object directly (id_colaborador present = success)
    if (response.data?.id_colaborador) {
      console.log('[RHSistemaService] Colaborador criado com sucesso (resposta direta):', response.data.id_colaborador);
      return {
        success: true,
        id_colaborador: response.data.id_colaborador
      };
    }

    throw new Error(response.data?.error || 'Resposta inesperada da API');

  } catch (error) {
    // Tratar erros específicos
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;

      if (status === 409) {
        // Colaborador já existe - tentar buscar o existente
        console.warn('[RHSistemaService] Colaborador já existe (409), buscando existente...');
        try {
          const existente = await buscarColaboradorPorCpf(cpf);
          if (existente) {
            return {
              success: true,
              id_colaborador: existente.id_colaborador,
              already_existed: true
            };
          }
          // 409 mas não encontrou = inconsistência
          throw new Error('Colaborador existe (409) mas não foi possível buscar registro');
        } catch (fetchError) {
          console.error('[RHSistemaService] Falha ao buscar colaborador existente:', fetchError.message);
          throw new Error(`Colaborador já existe mas não foi possível recuperar: ${fetchError.message}`);
        }
      }

      console.error('[RHSistemaService] Erro da API:', {
        status,
        error: errorData?.error,
        message: errorData?.message
      });

      throw new Error(`Erro ao criar colaborador: ${errorData?.error || error.message}`);
    }

    console.error('[RHSistemaService] Erro de conexão:', error.message);
    throw error;
  }
}

/**
 * Busca colaborador por CPF no RH Sistema
 *
 * @param {string} cpf - CPF do colaborador
 * @returns {Object|null} Dados do colaborador ou null se não encontrado
 * @throws {Error} Se houver erro de comunicação com a API (diferente de não encontrado)
 */
async function buscarColaboradorPorCpf(cpf) {
  if (!RH_SISTEMA_API_KEY) {
    console.warn('[RHSistemaService] RH_SISTEMA_API_KEY não configurada');
    throw new Error('RH_SISTEMA_API_KEY não configurada');
  }

  const cpfMasked = cpf ? `${cpf.substring(0, 3)}***` : '***';

  try {
    const response = await rhSistemaClient.get('/api/v1/colaboradores', {
      params: { cpf }
    });

    if (response.data?.success && response.data?.data?.length > 0) {
      return response.data.data[0];
    }

    // Não encontrado (resposta válida mas vazia)
    return null;

  } catch (error) {
    // 404 = genuinamente não encontrado
    if (error.response?.status === 404) {
      return null;
    }

    // Outros erros devem ser propagados para o chamador decidir
    console.error('[RHSistemaService] Erro ao buscar colaborador:', {
      cpf: cpfMasked,
      status: error.response?.status,
      message: error.message
    });
    throw new Error(`Erro ao buscar colaborador: ${error.message}`);
  }
}

/**
 * Atualiza tipo_vinculo do colaborador no RH Sistema
 *
 * @param {number} idColaborador - ID do colaborador
 * @param {number} tipoVinculo - Novo tipo_vinculo (usar constantes TIPO_VINCULO)
 * @returns {Object} { success: true }
 */
async function atualizarTipoVinculo(idColaborador, tipoVinculo) {
  console.log('[RHSistemaService] Atualizando tipo_vinculo:', { idColaborador, tipoVinculo });

  if (!RH_SISTEMA_API_KEY) {
    throw new Error('RH_SISTEMA_API_KEY não configurada');
  }

  try {
    const response = await rhSistemaClient.put(`/api/v1/colaborador/${idColaborador}`, {
      id_tipo_vinculo: tipoVinculo
    });

    // API returns { success: true, data: {...} } OR the colaborador object directly
    if (response.data?.success) {
      console.log('[RHSistemaService] tipo_vinculo atualizado com sucesso');
      return { success: true };
    }

    // API returns colaborador object directly (id_colaborador present = success)
    if (response.data?.id_colaborador) {
      console.log('[RHSistemaService] tipo_vinculo atualizado com sucesso (resposta direta)');
      return { success: true };
    }

    throw new Error(response.data?.error || 'Resposta inesperada da API');

  } catch (error) {
    if (error.response) {
      console.error('[RHSistemaService] Erro da API:', {
        status: error.response.status,
        error: error.response.data?.error
      });
      throw new Error(`Erro ao atualizar tipo_vinculo: ${error.response.data?.error || error.message}`);
    }

    console.error('[RHSistemaService] Erro de conexão:', error.message);
    throw error;
  }
}

/**
 * Verifica se a API do RH Sistema está disponível
 *
 * @returns {boolean} true se disponível
 */
async function healthCheck() {
  try {
    const response = await rhSistemaClient.get('/health', { timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    console.error('[RHSistemaService] Health check falhou:', error.message);
    return false;
  }
}

module.exports = {
  criarColaborador,
  buscarColaboradorPorCpf,
  atualizarTipoVinculo,
  healthCheck,
  TIPO_VINCULO
};
