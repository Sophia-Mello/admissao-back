/**
 * Job Routes - Unified
 *
 * CRUD de jobs subregionais com integracao Gupy
 * Unifica endpoints de job.js e subregional-jobs.js
 */

const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../db');
const { optionalAuth, requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');

// Lib functions - Orchestrators
const {
  createJobComplete,
  publishJobBatch,
  closeJobBatch,
  cancelJobBatch,
  deleteDraftsBatch,
  softDeleteBatch,
} = require('../lib/job');

// Lib functions - Helpers
const {
  fetchAndValidateTemplate,
  getJobsStatusFromGupy,
  updateJobStatus,
  FREE_JOB_BOARDS,
  VALID_JOB_STATUSES,
} = require('../lib/jobHelpers');

// Lib functions - Batch processing
const { processInBatches } = require('../lib/batch');

// Services
const gupyService = require('../services/gupyService');
const { logEvent } = require('../services/eventLogService');

/**
 * Middleware para validacao de erros
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Erro de validacao',
      details: errors.array(),
    });
  }
  next();
};

// ============================================================================
// CRUD BASICO
// ============================================================================

/**
 * GET /api/v1/jobs
 *
 * Lista jobs (com status Gupy enrichment e auto-sync)
 *
 * Query Params:
 * - id (opcional): filtrar por id_job_subregional
 * - id_job_gupy (opcional): filtrar por ID do job na Gupy
 * - id_subregional (opcional): filtrar por subregional
 * - id_regional (opcional): filtrar por regional
 * - id_unidade (opcional): filtrar por unidade vinculada
 * - job_status (opcional): filtrar por job_status (draft, published, closed, canceled)
 * - job_name (opcional): busca parcial no nome da vaga (ILIKE %termo%)
 * - job_code (opcional): filtrar por codigo da vaga (match exato)
 * - ativo (opcional): filtrar por status ativo
 * - include (opcional): "unidades" para incluir unidades vinculadas
 * - limit (opcional): numero de resultados (default: 50)
 * - offset (opcional): paginacao (default: 0)
 *
 * Response inclui contagem por status: total, total_drafts, total_published, total_closed, total_canceled
 */
router.get(
  '/',
  optionalAuth,
  [
    query('id').optional().isInt(),
    query('ids').optional().isString(),
    query('id_job_gupy').optional().isString(),
    query('id_subregional').optional().isInt(),
    query('id_regional').optional().isInt(),
    query('id_unidade').optional().isInt(),
    query('job_status').optional().isIn(['draft', 'published', 'closed', 'canceled']),
    query('job_name').optional().isString().isLength({ min: 2 }),
    query('job_code').optional().isString(),
    query('ativo').optional().isBoolean(),
    query('include').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id, ids, id_job_gupy, id_subregional, id_regional, id_unidade, job_status, job_name, job_code, ativo, include, limit = 50, offset = 0 } = req.query;

      let where = 'WHERE 1=1';
      const params = [];
      let idx = 1;

      // Filtro de ativo - usuarios nao autenticados veem apenas ativos
      if (ativo !== undefined) {
        where += ` AND js.ativo = $${idx}`;
        params.push(ativo === 'true');
        idx++;
      } else if (!req.user) {
        where += ' AND js.ativo = true';
      }

      // Filtro por múltiplos IDs (ids=1,2,3)
      if (ids) {
        const idsArray = ids.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        if (idsArray.length > 0) {
          where += ` AND js.id_job_subregional = ANY($${idx})`;
          params.push(idsArray);
          idx++;
        }
      } else if (id) {
        where += ` AND js.id_job_subregional = $${idx}`;
        params.push(id);
        idx++;
      }

      // Filtro por ID do job na Gupy
      if (id_job_gupy) {
        where += ` AND js.id_job_gupy = $${idx}`;
        params.push(id_job_gupy);
        idx++;
      }

      if (id_subregional) {
        where += ` AND js.id_subregional = $${idx}`;
        params.push(id_subregional);
        idx++;
      }

      if (id_regional) {
        where += ` AND sr.id_regional = $${idx}`;
        params.push(id_regional);
        idx++;
      }

      if (id_unidade) {
        where += ` AND EXISTS (
          SELECT 1 FROM job_unidade ju2
          WHERE ju2.id_job_subregional = js.id_job_subregional
          AND ju2.id_unidade = $${idx}
          AND ju2.active = true
        )`;
        params.push(id_unidade);
        idx++;
      }

      if (job_status) {
        where += ` AND js.job_status = $${idx}`;
        params.push(job_status);
        idx++;
      }

      if (job_name) {
        where += ` AND js.job_name ILIKE $${idx}`;
        params.push(`%${job_name}%`);
        idx++;
      }

      if (job_code) {
        where += ` AND js.job_code = $${idx}`;
        params.push(job_code);
        idx++;
      }

      const queryStr = `
        SELECT
          js.id_job_subregional,
          js.id_job_gupy,
          js.job_name,
          js.job_code,
          js.id_subregional,
          js.job_status,
          sr.nome_subregional,
          sr.id_regional,
          r.nome_regional,
          js.ativo,
          js.published_at,
          js.created_at,
          COUNT(ju.id_job_unidade) as total_unidades
        FROM job_subregional js
        LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
        LEFT JOIN regional r ON r.id_regional = sr.id_regional
        LEFT JOIN job_unidade ju ON ju.id_job_subregional = js.id_job_subregional AND ju.active = true
        ${where}
        GROUP BY js.id_job_subregional, js.id_job_gupy, js.job_name, js.job_code,
                 js.id_subregional, js.job_status, sr.nome_subregional, sr.id_regional, r.nome_regional,
                 js.ativo, js.published_at, js.created_at
        ORDER BY js.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `;

      params.push(limit, offset);

      const result = await db.query(queryStr, params);
      let jobs = result.rows;

      // Incluir unidades se solicitado (usa view local)
      if (include?.includes('unidades') && jobs.length > 0) {
        const jobIds = jobs.map((j) => j.id_job_subregional);
        const unidadesResult = await db.query(
          `SELECT ju.id_job_unidade, ju.id_job_subregional, ju.id_unidade, ju.active, u.nome_unidade
           FROM job_unidade ju
           JOIN unidade u ON u.id_unidade = ju.id_unidade
           WHERE ju.id_job_subregional = ANY($1) AND ju.active = true`,
          [jobIds]
        );

        const unidadesByJob = {};
        for (const u of unidadesResult.rows) {
          if (!unidadesByJob[u.id_job_subregional]) {
            unidadesByJob[u.id_job_subregional] = [];
          }
          unidadesByJob[u.id_job_subregional].push(u);
        }

        jobs = jobs.map((j) => ({
          ...j,
          unidades: unidadesByJob[j.id_job_subregional] || [],
        }));
      }

      // Enriquecer com status da Gupy
      const jobIds = jobs.map((j) => j.id_job_gupy).filter(Boolean);
      let gupyJobsMap = {};

      if (jobIds.length > 0) {
        gupyJobsMap = await getJobsStatusFromGupy(jobIds);
      }

      const jobsWithStatus = jobs.map((job) => {
        const gupyData = gupyJobsMap[job.id_job_gupy] || {
          status: job.job_status || 'draft',
          exists_in_gupy: true,
          name: null,
        };

        // Auto-sync: se status Gupy diferente do local, atualizar DB (fire-and-forget)
        if (job.id_job_gupy && gupyData.exists_in_gupy && gupyData.status !== job.job_status) {
          db.query(
            `UPDATE job_subregional SET job_status = $1, updated_at = NOW() WHERE id_job_subregional = $2`,
            [gupyData.status, job.id_job_subregional]
          ).catch(err => console.error('[Job GET] Auto-sync error:', err.message));
        }

        // Auto-desativar: se job foi deletado da Gupy, marcar como inativo
        if (job.id_job_gupy && !gupyData.exists_in_gupy && job.ativo) {
          db.query(
            `UPDATE job_subregional SET ativo = false, updated_at = NOW() WHERE id_job_subregional = $1`,
            [job.id_job_subregional]
          ).catch(err => console.error('[Job GET] Auto-deactivate error:', err.message));
        }

        return {
          ...job,
          job_status: gupyData.status,
          exists_in_gupy: gupyData.exists_in_gupy,
          gupy_name: gupyData.name,
        };
      });

      // Buscar contagem (com mesmos filtros, exceto status para contar por status)
      let countWhere = 'WHERE 1=1';
      const countParams = [];
      let countIdx = 1;

      if (ativo !== undefined) {
        countWhere += ` AND js.ativo = $${countIdx}`;
        countParams.push(ativo === 'true');
        countIdx++;
      } else if (!req.user) {
        countWhere += ' AND js.ativo = true';
      }

      if (id_subregional) {
        countWhere += ` AND js.id_subregional = $${countIdx}`;
        countParams.push(id_subregional);
        countIdx++;
      }

      if (id_regional) {
        countWhere += ` AND sr.id_regional = $${countIdx}`;
        countParams.push(id_regional);
        countIdx++;
      }

      if (id_unidade) {
        countWhere += ` AND EXISTS (
          SELECT 1 FROM job_unidade ju2
          WHERE ju2.id_job_subregional = js.id_job_subregional
          AND ju2.id_unidade = $${countIdx}
          AND ju2.active = true
        )`;
        countParams.push(id_unidade);
        countIdx++;
      }

      if (job_name) {
        countWhere += ` AND js.job_name ILIKE $${countIdx}`;
        countParams.push(`%${job_name}%`);
        countIdx++;
      }

      if (job_code) {
        countWhere += ` AND js.job_code = $${countIdx}`;
        countParams.push(job_code);
        countIdx++;
      }

      // Query com contagem por status (aplica todos os filtros exceto status, usa view local)
      const countResult = await db.query(
        `SELECT
           COUNT(DISTINCT js.id_job_subregional) as total,
           COUNT(DISTINCT js.id_job_subregional) FILTER (WHERE js.job_status = 'draft') as total_drafts,
           COUNT(DISTINCT js.id_job_subregional) FILTER (WHERE js.job_status = 'published') as total_published,
           COUNT(DISTINCT js.id_job_subregional) FILTER (WHERE js.job_status = 'closed') as total_closed,
           COUNT(DISTINCT js.id_job_subregional) FILTER (WHERE js.job_status = 'canceled') as total_canceled
         FROM job_subregional js
         LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
         ${countWhere}`,
        countParams
      );

      const counts = countResult.rows[0];

      return res.json({
        success: true,
        data: jobsWithStatus,
        total: parseInt(counts.total),
        total_drafts: parseInt(counts.total_drafts),
        total_published: parseInt(counts.total_published),
        total_closed: parseInt(counts.total_closed),
        total_canceled: parseInt(counts.total_canceled),
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
    } catch (error) {
      console.error('[Job GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar vagas' });
    }
  }
);

/**
 * GET /api/v1/jobs/verify
 *
 * Verifica se job existe (endpoint para n8n)
 *
 * Query Params:
 * - job_gupy_id: ID do job na Gupy
 */
router.get(
  '/verify',
  requireAuth,
  requireRecrutamento,
  [query('job_gupy_id').notEmpty().withMessage('job_gupy_id e obrigatorio')],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { job_gupy_id } = req.query;

      const result = await db.query(
        `SELECT id_job_subregional FROM job_subregional WHERE id_job_gupy = $1`,
        [job_gupy_id]
      );

      return res.json({
        exists: result.rows.length > 0,
        id_job_subregional: result.rows[0]?.id_job_subregional || null,
      });
    } catch (error) {
      console.error('[Job GET verify] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao verificar job',
      });
    }
  }
);

/**
 * POST /api/v1/jobs/publish
 *
 * Publica um ou mais jobs nos portais de emprego (em lote)
 *
 * Request Body:
 * {
 *   "ids": [1, 2, 3],                              // obrigatorio - array de IDs
 *   "jobBoards": [1, 3, 10, ...],                  // opcional - default: FREE_JOB_BOARDS
 *   "publishStatus": true,                         // opcional - se true, muda status para published
 *   "hiringDeadline": "2025-12-31T23:59:59Z",     // obrigatorio se publishStatus=true
 *   "applicationDeadline": "2025-12-31T23:59:59Z" // obrigatorio se publishStatus=true
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "results": [...],
 *   "summary": { "total": 3, "succeeded": 2, "failed": 1 }
 * }
 */
router.post(
  '/publish',
  requireAuth,
  requireRecrutamento,
  [
    body('ids')
      .notEmpty()
      .withMessage('ids e obrigatorio')
      .isArray({ min: 1 })
      .withMessage('ids deve ser um array com pelo menos 1 elemento'),
    body('ids.*').isInt({ min: 1 }).withMessage('Cada id deve ser um numero inteiro positivo'),
    body('jobBoards').optional().isArray().withMessage('jobBoards deve ser um array de numeros'),
    body('publishStatus').optional().isBoolean().withMessage('publishStatus deve ser boolean'),
    body('hiringDeadline')
      .optional()
      .isISO8601()
      .withMessage('hiringDeadline deve ser uma data valida no formato ISO'),
    body('applicationDeadline')
      .optional()
      .isISO8601()
      .withMessage('applicationDeadline deve ser uma data valida no formato ISO'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const {
        ids,
        jobBoards = FREE_JOB_BOARDS,
        publishStatus = false,
        hiringDeadline,
        applicationDeadline,
      } = req.body;

      // Validar campos obrigatorios para publicacao
      if (publishStatus) {
        const missingFields = [];
        if (!hiringDeadline) missingFields.push('hiringDeadline');
        if (!applicationDeadline) missingFields.push('applicationDeadline');

        if (missingFields.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Campos obrigatorios faltando para publicacao',
            missingFields,
            details: 'Para publicar vagas, voce deve fornecer: hiringDeadline e applicationDeadline.',
          });
        }
      }

      // Delegar para orchestrator
      const result = await publishJobBatch(
        ids,
        { jobBoards, publishStatus, hiringDeadline, applicationDeadline }
      );

      return res.status(result.summary.failed > 0 ? 207 : 200).json({
        success: result.summary.failed === 0,
        ...result,
        jobBoards,
        publishedStatus: publishStatus,
      });
    } catch (error) {
      console.error('[Job Publish] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao publicar jobs',
        details: error.message,
      });
    }
  }
);

/**
 * GET /api/v1/jobs/:id
 *
 * Detalhes de um job especifico
 */
router.get(
  '/:id',
  optionalAuth,
  [param('id').isInt()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const jobResult = await db.query(
        `SELECT js.*, sr.nome_subregional, sr.id_regional, r.nome_regional
         FROM job_subregional js
         LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
         LEFT JOIN regional r ON r.id_regional = sr.id_regional
         WHERE js.id_job_subregional = $1`,
        [req.params.id]
      );

      if (jobResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Vaga nao encontrada' });
      }

      // Usa view local (corrigido: antes usava ${db.schema}.unidade incorretamente)
      const unidadesResult = await db.query(
        `SELECT ju.id_job_unidade, ju.id_unidade, ju.active, u.nome_unidade, u.email_unidade_agendador
         FROM job_unidade ju
         JOIN unidade u ON u.id_unidade = ju.id_unidade
         WHERE ju.id_job_subregional = $1 AND ju.active = true
         ORDER BY u.nome_unidade`,
        [req.params.id]
      );

      return res.json({
        success: true,
        data: {
          ...jobResult.rows[0],
          unidades: unidadesResult.rows,
        },
      });
    } catch (error) {
      console.error('[Job GET :id] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar vaga' });
    }
  }
);

/**
 * POST /api/v1/jobs
 *
 * Cria job(s) COM integracao Gupy (suporta batch)
 *
 * Request Body (objeto unico - retrocompativel):
 * {
 *   "template_gupy_id": number|string,
 *   "id_subregional": number,
 *   "unidades": number[]  // opcional
 * }
 *
 * Request Body (array - batch create):
 * [
 *   { "template_gupy_id": 123, "id_subregional": 5, "unidades": [1,2] },
 *   { "template_gupy_id": 456, "id_subregional": 6 }
 * ]
 *
 * Response:
 * {
 *   "success": true,
 *   "results": [
 *     { "success": true, "id_job_subregional": 1, "id_job_gupy": 123, "job_name": "..." },
 *     { "success": false, "error": "Subregional nao encontrada" }
 *   ],
 *   "summary": { "total": 2, "succeeded": 1, "failed": 1 }
 * }
 */
router.post(
  '/',
  requireAuth,
  requireRecrutamento,
  [
    body().custom((value) => {
      const items = Array.isArray(value) ? value : [value];

      if (items.length === 0) {
        throw new Error('Body nao pode ser vazio');
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const prefix = items.length > 1 ? `Item ${i + 1}: ` : '';

        if (!item.template_gupy_id) {
          throw new Error(`${prefix}template_gupy_id e obrigatorio`);
        }
        if (!item.id_subregional) {
          throw new Error(`${prefix}id_subregional e obrigatorio`);
        }
        if (item.unidades && !Array.isArray(item.unidades)) {
          throw new Error(`${prefix}unidades deve ser um array`);
        }
      }

      return true;
    }),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      // Normalizar input para array
      const items = Array.isArray(req.body) ? req.body : [req.body];

      console.log(`[Job POST] Criando ${items.length} vaga(s)...`);

      // Processar em lotes paralelos (rate limit safe)
      const results = await processInBatches(items, (item) => createJobComplete(item));

      // Montar summary
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;

      console.log(`[Job POST] Concluido: ${succeeded} sucesso, ${failed} falha`);

      req._eventLogged = true;
      for (const r of results) {
        if (r.success) {
          logEvent({
            eventType: 'job.created',
            entityType: 'job',
            entityId: String(r.id_job_subregional),
            actorType: 'admin',
            actorId: req.user?.id?.toString() || null,
            actorName: req.user?.nome || null,
            metadata: { idJob: r.id_job_subregional, jobName: r.job_name },
            source: 'system',
            eventTimestamp: new Date(),
          });
        }
      }

      return res.status(failed > 0 ? 207 : 201).json({
        success: failed === 0,
        results,
        summary: { total: items.length, succeeded, failed },
      });
    } catch (error) {
      console.error('[Job POST] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao criar vagas',
        details: error.message,
      });
    }
  }
);

/**
 * PATCH /api/v1/jobs/:id
 *
 * Atualiza campos locais do job
 */
router.patch(
  '/:id',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt(),
    body('job_name').optional().isLength({ max: 255 }),
    body('job_code').optional().isLength({ max: 50 }),
    body('id_subregional').optional().isInt(),
    body('ativo').optional().isBoolean(),
    body('unidades').optional().isArray(),
  ],
  handleValidationErrors,
  async (req, res) => {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const { id } = req.params;
      const { job_name, job_code, id_subregional, ativo, unidades } = req.body;

      const existing = await client.query(
        'SELECT * FROM job_subregional WHERE id_job_subregional = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Vaga nao encontrada' });
      }

      const updates = [];
      const values = [];
      let idx = 1;

      if (job_name !== undefined) {
        updates.push(`job_name = $${idx}`);
        values.push(job_name);
        idx++;
      }

      if (job_code !== undefined) {
        updates.push(`job_code = $${idx}`);
        values.push(job_code);
        idx++;
      }

      if (id_subregional !== undefined) {
        updates.push(`id_subregional = $${idx}`);
        values.push(id_subregional);
        idx++;
      }

      if (ativo !== undefined) {
        updates.push(`ativo = $${idx}`);
        values.push(ativo);
        idx++;
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        values.push(id);
        await client.query(
          `UPDATE job_subregional SET ${updates.join(', ')} WHERE id_job_subregional = $${idx}`,
          values
        );
      }

      if (unidades !== undefined) {
        if (unidades.length === 0) {
          // Se vazio, desativa todos os job_unidade existentes
          await client.query(
            'UPDATE job_unidade SET active = false WHERE id_job_subregional = $1',
            [id]
          );
        } else {
          // Desativa os que NÃO estão na nova lista
          await client.query(
            'UPDATE job_unidade SET active = false WHERE id_job_subregional = $1 AND id_unidade != ALL($2)',
            [id, unidades]
          );

          // Upsert: insere ou ativa os que estão na lista
          for (const id_unidade of unidades) {
            await client.query(
              `INSERT INTO job_unidade (id_job_subregional, id_unidade, active)
               VALUES ($1, $2, true)
               ON CONFLICT (id_unidade, id_job_subregional)
               DO UPDATE SET active = true`,
              [id, id_unidade]
            );
          }
        }
      }

      await client.query('COMMIT');

      const updatedJob = await db.query(
        `SELECT js.*, sr.nome_subregional
         FROM job_subregional js
         LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
         WHERE js.id_job_subregional = $1`,
        [id]
      );

      req._eventLogged = true;
      logEvent({
        eventType: 'job.updated',
        entityType: 'job',
        entityId: String(req.params.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idJob: parseInt(req.params.id), changedFields: Object.keys(req.body) },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.json({ success: true, data: updatedJob.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Job PATCH] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar vaga' });
    } finally {
      client.release();
    }
  }
);

// ============================================================================
// RELACIONAMENTO JOB-UNIDADE
// ============================================================================

/**
 * POST /api/v1/jobs/:id/unidades
 *
 * Vincula unidade a um job
 */
router.post(
  '/:id/unidades',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt(), body('id_unidade').notEmpty().isInt()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const result = await db.query(
        `INSERT INTO job_unidade (id_job_subregional, id_unidade)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [req.params.id, req.body.id_unidade]
      );

      if (result.rows.length === 0) {
        return res.status(409).json({ success: false, error: 'Unidade ja vinculada' });
      }

      req._eventLogged = true;
      logEvent({
        eventType: 'job.unit_linked',
        entityType: 'job',
        entityId: String(req.params.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idJob: parseInt(req.params.id), idUnidade: req.body.id_unidade },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[Job POST unidades] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao vincular unidade' });
    }
  }
);

/**
 * DELETE /api/v1/jobs/:id/unidades/:id_unidade
 *
 * Desvincula unidade de um job
 */
router.delete(
  '/:id/unidades/:id_unidade',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt(), param('id_unidade').isInt()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const result = await db.query(
        `DELETE FROM job_unidade
         WHERE id_job_subregional = $1 AND id_unidade = $2
         RETURNING id_job_unidade`,
        [req.params.id, req.params.id_unidade]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Vinculo nao encontrado' });
      }

      req._eventLogged = true;
      logEvent({
        eventType: 'job.unit_unlinked',
        entityType: 'job',
        entityId: String(req.params.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idJob: parseInt(req.params.id), idUnidade: parseInt(req.params.id_unidade) },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.json({ success: true, message: 'Unidade desvinculada' });
    } catch (error) {
      console.error('[Job DELETE unidades] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao desvincular unidade' });
    }
  }
);

// ============================================================================
// OPERACOES GUPY
// ============================================================================

/**
 * GET /api/v1/jobs/:id/gupy
 *
 * Busca dados do template Gupy associado ao job
 */
router.get(
  '/:id/gupy',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt({ min: 1 }).withMessage('ID deve ser um numero inteiro positivo')],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Buscar job para obter id_template_gupy
      const jobResult = await db.query(
        `SELECT id_template_gupy, job_name FROM job_subregional WHERE id_job_subregional = $1`,
        [id]
      );

      if (jobResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Job nao encontrado',
        });
      }

      const { id_template_gupy, job_name } = jobResult.rows[0];

      // Buscar template completo da Gupy
      try {
        const template = await fetchAndValidateTemplate(id_template_gupy);

        return res.json({
          success: true,
          data: {
            id: template.id,
            name: job_name,
            description: template.description || '',
            responsibilities: template.responsibilities || '',
            prerequisites: template.prerequisites || '',
            additionalInformation: template.additionalInformation || '',
            careerPageId: template.careerPageId,
          },
        });
      } catch (gupyError) {
        return res.status(gupyError.status || 500).json({
          success: false,
          error: 'Erro ao buscar dados do template na Gupy',
          details: gupyError.message,
        });
      }
    } catch (error) {
      console.error('[Job GET gupy] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao buscar dados do job',
      });
    }
  }
);

/**
 * POST /api/v1/jobs/:id/sync
 *
 * Sincroniza campos HTML do template Gupy para o job local
 */
router.post(
  '/:id/sync',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt({ min: 1 }).withMessage('ID deve ser um numero inteiro positivo')],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id } = req.params;

      // 1. Buscar job
      const jobResult = await db.query(
        `SELECT id_job_subregional, id_template_gupy, job_name
         FROM job_subregional
         WHERE id_job_subregional = $1`,
        [id]
      );

      if (jobResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Job nao encontrado',
        });
      }

      const job = jobResult.rows[0];

      // 2. Buscar template completo da Gupy
      let template;
      try {
        console.log(`[Job Sync] Buscando template ${job.id_template_gupy}...`);
        template = await fetchAndValidateTemplate(job.id_template_gupy);
      } catch (templateError) {
        return res.status(templateError.status || 500).json({
          success: false,
          error: 'Erro ao buscar template da Gupy',
          details: templateError.message,
        });
      }

      // 3. Atualizar job_subregional com campos do template
      await db.query(
        `UPDATE job_subregional
         SET description = $1,
             responsibilities = $2,
             prerequisites = $3,
             additional_information = $4,
             updated_at = NOW()
         WHERE id_job_subregional = $5`,
        [
          template.description || null,
          template.responsibilities || null,
          template.prerequisites || null,
          template.additionalInformation || null,
          id,
        ]
      );

      console.log(`[Job Sync] Job ${id} atualizado com campos do template`);

      return res.json({
        success: true,
        message: 'Campos HTML sincronizados com o template',
        data: {
          description: !!template.description,
          responsibilities: !!template.responsibilities,
          prerequisites: !!template.prerequisites,
          additionalInformation: !!template.additionalInformation,
        },
      });
    } catch (error) {
      console.error('[Job Sync] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao sincronizar campos do template',
      });
    }
  }
);

/**
 * PATCH /api/v1/jobs/:id/status
 *
 * Atualiza status do job na Gupy
 *
 * Request Body:
 * {
 *   "status": "published" | "draft" | "frozen" | "closed" | ...
 * }
 */
router.patch(
  '/:id/status',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt({ min: 1 }).withMessage('ID deve ser um numero inteiro positivo'),
    body('status')
      .notEmpty()
      .withMessage('status e obrigatorio')
      .isIn(VALID_JOB_STATUSES)
      .withMessage(`Status invalido. Valores permitidos: ${VALID_JOB_STATUSES.join(', ')}`),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      console.log(`[Job Status] Atualizando status do job ${id} para: ${status}`);

      // 1. Buscar job
      const jobResult = await db.query(
        `SELECT id_job_subregional, id_job_gupy, job_name
         FROM job_subregional
         WHERE id_job_subregional = $1`,
        [id]
      );

      if (jobResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Job nao encontrado',
        });
      }

      const job = jobResult.rows[0];

      // 2. Atualizar status na Gupy
      try {
        const result = await updateJobStatus(job.id_job_gupy, status);

        console.log(`[Job Status] Status atualizado na Gupy para: ${status}`);

        return res.json({
          success: true,
          message: `Status atualizado para ${status}`,
          data: {
            id_job_subregional: job.id_job_subregional,
            id_job_gupy: job.id_job_gupy,
            job_name: job.job_name,
            status: result.status || status,
          },
        });
      } catch (gupyError) {
        console.error('[Job Status] Erro ao atualizar status na Gupy:', gupyError);
        return res.status(gupyError.status || 500).json({
          success: false,
          error: 'Erro ao atualizar status na Gupy',
          details: gupyError.message,
          gupyData: gupyError.gupyData,
        });
      }
    } catch (error) {
      console.error('[Job Status] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao atualizar status do job',
        details: error.message,
      });
    }
  }
);

// ============================================================================
// OPERACOES EM LOTE (BATCH)
// ============================================================================

/**
 * DELETE /api/v1/jobs
 *
 * Deleta jobs em lote (soft delete - marca ativo=false)
 *
 * Query Params:
 * - ids: "1,2,3" (comma-separated list of IDs)
 *
 * Exemplo: DELETE /api/v1/jobs?ids=1,2,3
 */
router.delete(
  '/',
  requireAuth,
  requireRecrutamento,
  [query('ids').notEmpty().withMessage('ids e obrigatorio')],
  handleValidationErrors,
  async (req, res) => {
    try {
      // Parse: "1,2,3" -> [1, 2, 3]
      const ids = req.query.ids
        .split(',')
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0);

      if (ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Nenhum ID valido fornecido',
        });
      }

      // Delegar para orchestrator
      const result = await softDeleteBatch(ids);

      return res.status(result.summary.failed > 0 ? 207 : 200).json({
        success: result.summary.failed === 0,
        ...result,
      });
    } catch (error) {
      console.error('[Job Delete] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao deletar jobs',
        details: error.message,
      });
    }
  }
);

/**
 * POST /api/v1/jobs/close
 *
 * Fecha vagas em lote na Gupy (status = closed)
 *
 * Request Body:
 * {
 *   "ids": [1, 2, 3]
 * }
 */
router.post(
  '/close',
  requireAuth,
  requireRecrutamento,
  [
    body('ids')
      .notEmpty()
      .withMessage('ids e obrigatorio')
      .isArray({ min: 1 })
      .withMessage('ids deve ser um array com pelo menos 1 elemento'),
    body('ids.*').isInt({ min: 1 }).withMessage('Cada id deve ser um numero inteiro positivo'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { ids } = req.body;

      // Delegar para orchestrator
      const result = await closeJobBatch(ids);

      return res.status(result.summary.failed > 0 ? 207 : 200).json({
        success: result.summary.failed === 0,
        ...result,
      });
    } catch (error) {
      console.error('[Job Close] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao fechar vagas',
        details: error.message,
      });
    }
  }
);

/**
 * POST /api/v1/jobs/cancel
 *
 * Cancela vagas em lote na Gupy (status = canceled)
 *
 * Request Body:
 * {
 *   "ids": [1, 2, 3],
 *   "cancelReasonNotes": "Motivo do cancelamento"
 * }
 */
router.post(
  '/cancel',
  requireAuth,
  requireRecrutamento,
  [
    body('ids')
      .notEmpty()
      .withMessage('ids e obrigatorio')
      .isArray({ min: 1 })
      .withMessage('ids deve ser um array com pelo menos 1 elemento'),
    body('ids.*').isInt({ min: 1 }).withMessage('Cada id deve ser um numero inteiro positivo'),
    body('cancelReasonNotes')
      .notEmpty()
      .withMessage('cancelReasonNotes e obrigatorio')
      .isString()
      .withMessage('cancelReasonNotes deve ser uma string'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { ids, cancelReasonNotes } = req.body;

      // Delegar para orchestrator
      const result = await cancelJobBatch(ids, cancelReasonNotes);

      return res.status(result.summary.failed > 0 ? 207 : 200).json({
        success: result.summary.failed === 0,
        ...result,
      });
    } catch (error) {
      console.error('[Job Cancel] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao cancelar vagas',
        details: error.message,
      });
    }
  }
);

/**
 * POST /api/v1/jobs/delete-drafts
 *
 * Deleta rascunhos (drafts) em lote na Gupy
 * IMPORTANTE: Só funciona para jobs com status "draft"
 *
 * Request Body:
 * {
 *   "ids": [1, 2, 3]
 * }
 */
router.post(
  '/delete-drafts',
  requireAuth,
  requireRecrutamento,
  [
    body('ids')
      .notEmpty()
      .withMessage('ids e obrigatorio')
      .isArray({ min: 1 })
      .withMessage('ids deve ser um array com pelo menos 1 elemento'),
    body('ids.*').isInt({ min: 1 }).withMessage('Cada id deve ser um numero inteiro positivo'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { ids } = req.body;

      // Delegar para orchestrator
      const result = await deleteDraftsBatch(ids);

      return res.status(result.summary.failed > 0 ? 207 : 200).json({
        success: result.summary.failed === 0,
        ...result,
      });
    } catch (error) {
      console.error('[Job Delete Drafts] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao deletar rascunhos',
        details: error.message,
      });
    }
  }
);

module.exports = router;
