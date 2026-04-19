/**
 * Orquestradores de jobs (operações complexas com transações)
 *
 * Este arquivo contém funções que coordenam múltiplas operações:
 * - Queries de banco de dados
 * - Chamadas à API Gupy
 * - Transações
 */

const db = require('../../db');
const gupyService = require('../services/gupyService');
const { processInBatches, buildBatchResponse } = require('./batch');
const {
  fetchAndValidateTemplate,
  buildJobName,
  extractJobCode,
  createJobInGupy,
  validatePublishRequirements,
  publishJob,
  updateJobStatus,
} = require('./jobHelpers');

// ============================================================================
// ORCHESTRATORS - Operações complexas
// ============================================================================

/**
 * Cria um job completo (validação + Gupy + banco)
 *
 * Migrado de lib/jobGupy.js
 *
 * @param {Object} params
 * @param {number} params.template_gupy_id - ID do template na Gupy
 * @param {number} params.id_subregional - ID da subregional
 * @param {number[]} [params.unidades] - IDs das unidades (opcional)
 * @returns {Promise<Object>} { success, id_job_subregional, id_job_gupy, job_name, unidades_vinculadas } ou { success: false, error }
 */
async function createJobComplete({ template_gupy_id, id_subregional, unidades }) {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // 1. Validar subregional (usa view local)
    const subregionalResult = await client.query(
      `SELECT id_subregional, nome_subregional FROM subregional WHERE id_subregional = $1`,
      [id_subregional]
    );
    if (subregionalResult.rows.length === 0) {
      throw new Error('Subregional não encontrada');
    }
    const subregional = subregionalResult.rows[0];

    // 2. Validar unidades (se fornecidas - usa view local)
    let unidadesEncontradas = [];
    if (unidades && unidades.length > 0) {
      const unidadesResult = await client.query(
        `SELECT id_unidade, nome_unidade FROM unidade WHERE id_unidade = ANY($1)`,
        [unidades]
      );
      if (unidadesResult.rows.length === 0) {
        throw new Error('Nenhuma unidade encontrada');
      }
      unidadesEncontradas = unidadesResult.rows;
    }

    // 3. Buscar e validar template
    const template = await fetchAndValidateTemplate(template_gupy_id);
    const templateName = template.name || template.title;
    const job_name = buildJobName(templateName, subregional.nome_subregional);
    const job_code = extractJobCode(templateName);

    // 4. Criar job na Gupy
    const jobGupy = await createJobInGupy({
      templateId: template_gupy_id,
      name: job_name,
      code: job_code,
      type: template.type,
      departmentId: template.departmentId,
      roleId: template.roleId,
    });

    // 5. Salvar no banco
    const jobResult = await client.query(
      `INSERT INTO job_subregional (
        id_job_gupy, id_template_gupy, id_subregional, job_name, job_code,
        description, responsibilities, prerequisites, additional_information, template_name, ativo,
        type, "departmentId", "departmentName", "roleId", "roleName"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12, $13, $14, $15) RETURNING *`,
      [
        jobGupy.id,
        template_gupy_id,
        id_subregional,
        job_name,
        job_code,
        template.description || null,
        template.responsibilities || null,
        template.prerequisites || null,
        template.additionalInformation || null,
        templateName || null,
        jobGupy.type || null,
        jobGupy.departmentId || null,
        jobGupy.departmentName || null,
        jobGupy.roleId || null,
        jobGupy.roleName || null,
      ]
    );
    const job = jobResult.rows[0];

    // 6. Vincular unidades
    if (unidadesEncontradas.length > 0) {
      const values = unidadesEncontradas.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
      const params = unidadesEncontradas.flatMap((u) => [u.id_unidade, job.id_job_subregional]);
      await client.query(`INSERT INTO job_unidade (id_unidade, id_job_subregional) VALUES ${values}`, params);
    }

    await client.query('COMMIT');

    console.log(`[Job] Job criado com sucesso: ${job.id_job_subregional} (Gupy: ${job.id_job_gupy})`);

    return {
      success: true,
      id_job_subregional: job.id_job_subregional,
      id_job_gupy: job.id_job_gupy,
      job_name: job.job_name,
      unidades_vinculadas: unidadesEncontradas.map((u) => ({
        id_unidade: u.id_unidade,
        nome_unidade: u.nome_unidade,
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Job] Erro ao criar job:`, err.message);
    return { success: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Publica jobs em batch
 *
 * Extraído de POST /jobs/publish
 *
 * @param {number[]} ids - IDs dos jobs
 * @param {Object} options - Opções de publicação
 * @param {number[]} [options.jobBoards] - IDs dos job boards
 * @param {boolean} [options.publishStatus] - Se deve mudar status para published
 * @param {string} [options.hiringDeadline] - Data limite de contratação
 * @param {string} [options.applicationDeadline] - Data limite de inscrição
 * @returns {Promise<Object>} { results, summary }
 */
async function publishJobBatch(ids, options) {
  const {
    jobBoards,
    publishStatus = false,
    hiringDeadline,
    applicationDeadline,
  } = options;

  console.log(`[Job] Iniciando publicação de ${ids.length} job(s)`);

  // Buscar todos os jobs de uma vez (usa view local)
  const jobsResult = await db.query(
    `SELECT
      js.id_job_subregional,
      js.id_job_gupy,
      js.id_subregional,
      js.job_name,
      js.description,
      js.responsibilities,
      js.prerequisites,
      js.additional_information,
      sr.endereco
     FROM job_subregional js
     LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
     WHERE js.id_job_subregional = ANY($1)`,
    [ids]
  );

  // Mapear jobs por ID
  const jobsMap = {};
  for (const job of jobsResult.rows) {
    jobsMap[job.id_job_subregional] = job;
  }

  // Processar cada job
  const results = await processInBatches(ids, async (id) => {
    const job = jobsMap[id];

    // Job não encontrado
    if (!job) {
      return { id, success: false, error: 'Job não encontrado' };
    }

    // Validar campos HTML
    const validation = validatePublishRequirements(job);
    if (!validation.valid) {
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: 'Campos HTML faltando',
        missingFields: validation.missingFields,
      };
    }

    // Validar endereço
    if (!job.endereco) {
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: 'Endereço da subregional não encontrado',
      };
    }

    // Publicar na Gupy
    try {
      const result = await publishJob(job.id_job_gupy, {
        endereco: job.endereco,
        hiringDeadline,
        applicationDeadline,
        jobBoards,
        publishStatus,
      });

      // Atualizar published_at local
      if (publishStatus) {
        await db.query(
          `UPDATE job_subregional SET job_status = 'published', published_at = NOW(), updated_at = NOW() WHERE id_job_subregional = $1`,
          [id]
        );
      }

      console.log(`[Job] Job ${id} publicado com sucesso`);

      return {
        id,
        job_name: job.job_name,
        id_job_gupy: job.id_job_gupy,
        success: true,
        status: result.status || 'published',
      };
    } catch (gupyError) {
      console.error(`[Job] Erro ao publicar job ${id}:`, gupyError.message);
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: gupyError.message,
      };
    }
  });

  return buildBatchResponse(results);
}

/**
 * Fecha jobs em batch na Gupy (status = closed)
 *
 * Extraído de POST /jobs/close
 *
 * @param {number[]} ids - IDs dos jobs
 * @returns {Promise<Object>} { results, summary }
 */
async function closeJobBatch(ids) {
  console.log(`[Job] Fechando ${ids.length} vaga(s)`);

  // Buscar todos os jobs
  const jobsResult = await db.query(
    `SELECT id_job_subregional, id_job_gupy, job_name
     FROM job_subregional
     WHERE id_job_subregional = ANY($1)`,
    [ids]
  );

  const jobsMap = {};
  for (const job of jobsResult.rows) {
    jobsMap[job.id_job_subregional] = job;
  }

  const results = await processInBatches(ids, async (id) => {
    const job = jobsMap[id];

    if (!job) {
      return { id, success: false, error: 'Job não encontrado' };
    }

    if (!job.id_job_gupy) {
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: 'Job não tem id_job_gupy (não foi criado na Gupy)',
      };
    }

    try {
      await updateJobStatus(job.id_job_gupy, 'closed');

      // Atualizar status local
      await db.query(
        `UPDATE job_subregional SET job_status = 'closed', updated_at = NOW() WHERE id_job_subregional = $1`,
        [id]
      );

      console.log(`[Job] Job ${id} fechado`);

      return {
        id,
        job_name: job.job_name,
        id_job_gupy: job.id_job_gupy,
        success: true,
        status: 'closed',
      };
    } catch (gupyError) {
      console.error(`[Job] Erro ao fechar job ${id}:`, gupyError.message);
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: gupyError.message,
      };
    }
  });

  return buildBatchResponse(results);
}

/**
 * Cancela jobs em batch na Gupy (status = canceled)
 *
 * Extraído de POST /jobs/cancel
 *
 * @param {number[]} ids - IDs dos jobs
 * @param {string} cancelReasonNotes - Motivo do cancelamento
 * @returns {Promise<Object>} { results, summary }
 */
async function cancelJobBatch(ids, cancelReasonNotes) {
  console.log(`[Job] Cancelando ${ids.length} vaga(s). Motivo: ${cancelReasonNotes}`);

  // Buscar todos os jobs
  const jobsResult = await db.query(
    `SELECT id_job_subregional, id_job_gupy, job_name
     FROM job_subregional
     WHERE id_job_subregional = ANY($1)`,
    [ids]
  );

  const jobsMap = {};
  for (const job of jobsResult.rows) {
    jobsMap[job.id_job_subregional] = job;
  }

  const results = await processInBatches(ids, async (id) => {
    const job = jobsMap[id];

    if (!job) {
      return { id, success: false, error: 'Job não encontrado' };
    }

    if (!job.id_job_gupy) {
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: 'Job não tem id_job_gupy (não foi criado na Gupy)',
      };
    }

    try {
      // Cancelar na Gupy com cancelReason e cancelReasonNotes
      await gupyService.updateJob(job.id_job_gupy, {
        status: 'canceled',
        cancelReason: 'other',
        cancelReasonNotes: cancelReasonNotes,
      });

      // Atualizar status local
      await db.query(
        `UPDATE job_subregional SET job_status = 'canceled', updated_at = NOW() WHERE id_job_subregional = $1`,
        [id]
      );

      console.log(`[Job] Job ${id} cancelado`);

      return {
        id,
        job_name: job.job_name,
        id_job_gupy: job.id_job_gupy,
        success: true,
        status: 'canceled',
      };
    } catch (gupyError) {
      console.error(`[Job] Erro ao cancelar job ${id}:`, gupyError.message);
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: gupyError.message,
      };
    }
  });

  return buildBatchResponse(results);
}

/**
 * Deleta rascunhos (drafts) em batch na Gupy
 *
 * Extraído de POST /jobs/delete-drafts
 *
 * @param {number[]} ids - IDs dos jobs
 * @returns {Promise<Object>} { results, summary }
 */
async function deleteDraftsBatch(ids) {
  console.log(`[Job] Deletando ${ids.length} rascunho(s)`);

  // Buscar todos os jobs
  const jobsResult = await db.query(
    `SELECT id_job_subregional, id_job_gupy, job_name
     FROM job_subregional
     WHERE id_job_subregional = ANY($1)`,
    [ids]
  );

  const jobsMap = {};
  for (const job of jobsResult.rows) {
    jobsMap[job.id_job_subregional] = job;
  }

  const results = await processInBatches(ids, async (id) => {
    const job = jobsMap[id];

    if (!job) {
      return { id, success: false, error: 'Job não encontrado' };
    }

    if (!job.id_job_gupy) {
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: 'Job não tem id_job_gupy (não foi criado na Gupy)',
      };
    }

    try {
      await gupyService.deleteDraftJob(job.id_job_gupy);

      // Hard delete local (job_unidade é deletado via CASCADE)
      await db.query('DELETE FROM job_subregional WHERE id_job_subregional = $1', [id]);

      console.log(`[Job] Job ${id} deletado (hard delete)`);

      return {
        id,
        job_name: job.job_name,
        id_job_gupy: job.id_job_gupy,
        success: true,
      };
    } catch (gupyError) {
      console.error(`[Job] Erro ao deletar job ${id}:`, gupyError.message);
      return {
        id,
        job_name: job.job_name,
        success: false,
        error: gupyError.message,
      };
    }
  });

  return buildBatchResponse(results);
}

/**
 * Soft delete em batch (marca ativo=false)
 *
 * Extraído de DELETE /jobs
 *
 * @param {number[]} ids - IDs dos jobs
 * @returns {Promise<Object>} { results, summary }
 */
async function softDeleteBatch(ids) {
  console.log(`[Job] Deletando (soft) ${ids.length} job(s)`);

  const results = await processInBatches(ids, async (id) => {
    try {
      // Verificar se job existe
      const existing = await db.query(
        'SELECT id_job_subregional, job_name, ativo FROM job_subregional WHERE id_job_subregional = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        return { id, success: false, error: 'Job não encontrado' };
      }

      const job = existing.rows[0];

      if (!job.ativo) {
        return {
          id,
          job_name: job.job_name,
          success: true,
          message: 'Job já estava inativo',
        };
      }

      // Soft delete
      await db.query(
        'UPDATE job_subregional SET ativo = false, updated_at = NOW() WHERE id_job_subregional = $1',
        [id]
      );

      console.log(`[Job] Job ${id} deletado (soft)`);

      return {
        id,
        job_name: job.job_name,
        success: true,
      };
    } catch (err) {
      console.error(`[Job] Erro ao deletar job ${id}:`, err.message);
      return {
        id,
        success: false,
        error: err.message,
      };
    }
  });

  return buildBatchResponse(results);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Orchestrators
  createJobComplete,
  publishJobBatch,
  closeJobBatch,
  cancelJobBatch,
  deleteDraftsBatch,
  softDeleteBatch,
};
