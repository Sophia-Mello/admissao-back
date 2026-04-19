/**
 * Application Routes - Gestao de Candidaturas
 *
 * - CRUD de applications com dados sincronizados da Gupy
 * - Sync on-demand com Gupy API v2 (step data)
 * - Email templates da Gupy (GET)
 * - Mass email actions via Gupy API v2
 */

const express = require('express');
const router = express.Router();
const { query, param, validationResult } = require('express-validator');
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const { syncApplications } = require('../lib/applicationSync');
const batchAction = require('../lib/batchAction');

/**
 * Generate error ID for correlation with logs
 */
function generateErrorId() {
  return `ERR-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

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

/**
 * Append cvSearch WHERE clauses (AND lógico por palavra)
 *
 * Each space-separated term becomes a separate ILIKE condition on c.cv_data,
 * so all terms must match (AND logic).
 *
 * @param {string} cvSearch - Raw search string from query param
 * @param {string} where - Current WHERE clause
 * @param {any[]} params - Current query params array (mutated in place)
 * @param {number} idx - Current parameter index
 * @returns {{ where: string, idx: number }} Updated where clause and index
 */
function appendCvSearchWhere(cvSearch, where, params, idx) {
  const terms = cvSearch.trim().split(/\s+/).filter(Boolean).slice(0, 10);
  for (const term of terms) {
    // Escape ILIKE wildcards (%, _, \) so they match literally
    const escaped = term.replace(/[%_\\]/g, '\\$&');
    where += ` AND c.cv_data::text ILIKE $${idx}`;
    params.push(`%${escaped}%`);
    idx++;
  }
  return { where, idx, termCount: terms.length };
}

// ============================================================================
// CRUD BASICO
// ============================================================================

/**
 * GET /api/v1/applications
 *
 * Lista applications com filtros e paginacao
 *
 * Query Params:
 * - include: "candidate" para incluir dados do candidato
 * - template: filtrar por template name
 * - subregional: filtrar por id_subregional
 * - step: filtrar por current_step_name
 * - stepStatus: filtrar por current_step_status
 * - statusApplication: filtrar por status_application
 * - statusAulaTeste: 'pendente' - candidatos em etapa Aula Teste ou Entrevista sem booking ativo
 * - statusProva: 'pendente' | 'agendado' | 'compareceu' | 'faltou' | 'cancelado' - status da prova teorica
 * - search: busca por CPF ou nome
 * - cvSearch: busca textual no cv_data (palavras separadas por espaço = AND lógico)
 * - limit: numero de resultados (default: 50, max: 100)
 * - offset: paginacao (default: 0)
 */
router.get(
  '/',
  requireAuth,
  requireRecrutamento,
  [
    query('include').optional().isString(),
    query('template').optional().isString(),
    query('subregional').optional().isInt(),
    query('step').optional().isString(),
    query('stepStatus').optional().isString(),
    query('statusApplication').optional().isString(),
    query('statusAulaTeste').optional().isIn(['pendente']),
    query('statusProva').optional().isIn(['pendente', 'agendado', 'compareceu', 'faltou', 'cancelado']),
    query('tag').optional().isString(),
    query('search').optional().isString().isLength({ min: 2 }),
    query('cvSearch').optional().isString().isLength({ min: 2, max: 200 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const {
        include,
        template,
        subregional,
        step,
        stepStatus,
        statusApplication,
        statusAulaTeste,
        statusProva,
        tag,
        search,
        cvSearch,
        limit = 50,
        offset = 0,
      } = req.query;

      const includeCandidate = include === 'candidate';

      let where = 'WHERE 1=1';
      const params = [];
      let idx = 1;

      // Filtro por template
      if (template) {
        where += ` AND js.template_name ILIKE $${idx}`;
        params.push(`%${template}%`);
        idx++;
      }

      // Filtro por subregional
      if (subregional) {
        where += ` AND js.id_subregional = $${idx}`;
        params.push(subregional);
        idx++;
      }

      // Filtro por step name
      if (step) {
        where += ` AND a.current_step_name ILIKE $${idx}`;
        params.push(`%${step}%`);
        idx++;
      }

      // Filtro por step status
      if (stepStatus) {
        where += ` AND a.current_step_status = $${idx}`;
        params.push(stepStatus);
        idx++;
      }

      // Filtro por status application
      if (statusApplication) {
        where += ` AND a.status_application = $${idx}`;
        params.push(statusApplication);
        idx++;
      }

      // Filtro por status aula teste (pendente = na etapa Aula Teste ou Entrevista sem booking ativo)
      if (statusAulaTeste === 'pendente') {
        where += ` AND a.current_step_name IN ('Aula Teste', 'Entrevista')`;
        where += ` AND NOT EXISTS (
          SELECT 1 FROM booking b
          WHERE b.id_application_gupy = a.id_application_gupy
          AND b.status_booking NOT IN ('cancelado', 'faltou')
        )`;
      }

      // Filtro por status prova teorica (suporta tipos: prova_teorica, prova_online_professor, prova_online_pedagogo, prova_online_monitor)
      if (statusProva) {
        if (statusProva === 'pendente') {
          // Pendente = na etapa Agendamento de Prova Online e sem event_application ativo
          where += ` AND a.current_step_name = 'Agendamento de Prova Online'`;
          where += ` AND NOT EXISTS (
            SELECT 1 FROM event_application ea
            JOIN event e ON e.id = ea.id_event
            WHERE ea.id_application = a.id
            AND e.type LIKE 'prova_%'
            AND ea.status IN ('agendado', 'compareceu')
          )`;
        } else {
          // Outros status: agendado, compareceu, faltou (qualquer etapa)
          where += ` AND EXISTS (
            SELECT 1 FROM event_application ea
            JOIN event e ON e.id = ea.id_event
            WHERE ea.id_application = a.id
            AND e.type LIKE 'prova_%'
            AND ea.status = $${idx}
          )`;
          params.push(statusProva);
          idx++;
        }
      }

      // Filtro por tag (JSONB contains)
      if (tag) {
        where += ` AND a.tags @> $${idx}::jsonb`;
        params.push(JSON.stringify([tag]));  // Tags are strings, not objects
        idx++;
      }

      // Busca por CPF ou nome
      if (search) {
        if (!includeCandidate) {
          return res.status(400).json({
            success: false,
            error: 'O parametro search requer include=candidate',
          });
        }
        where += ` AND (c.cpf ILIKE $${idx} OR c.nome ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }

      // Busca textual no cv_data (cada palavra separada por espaço = AND lógico)
      if (cvSearch) {
        if (!includeCandidate) {
          return res.status(400).json({
            success: false,
            error: 'O parametro cvSearch requer include=candidate',
          });
        }
        const result = appendCvSearchWhere(cvSearch, where, params, idx);
        if (result.termCount === 0) {
          return res.status(400).json({
            success: false,
            error: 'cvSearch deve conter pelo menos um termo de busca valido',
          });
        }
        ({ where, idx } = result);
      }

      // Select fields
      let selectFields = `
        a.id,
        a.id_application_gupy,
        a.id_job_subregional,
        a.current_step_id,
        a.current_step_name,
        a.current_step_status,
        a.status_application,
        a.step_updated_at AS current_step_started_at,
        a.gupy_synced_at,
        a.created_at,
        a.tags,
        js.job_name,
        js.template_name,
        js.id_job_gupy,
        sr.nome_subregional,
        sr.id_subregional
      `;

      if (includeCandidate) {
        selectFields += `,
          c.id AS candidate_id,
          c.nome AS candidate_nome,
          c.cpf AS candidate_cpf,
          c.email AS candidate_email,
          c.telefone AS candidate_telefone
        `;
      }

      const queryStr = `
        SELECT ${selectFields}
        FROM application a
        JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
        LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
        ${includeCandidate ? 'JOIN candidate c ON c.id = a.id_candidate' : ''}
        ${where}
        ORDER BY a.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `;

      params.push(limit, offset);

      const result = await db.query(queryStr, params);

      // Count total
      const countParams = params.slice(0, -2); // Remove limit/offset
      const countQuery = `
        SELECT COUNT(*) as total
        FROM application a
        JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
        LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
        ${includeCandidate ? 'JOIN candidate c ON c.id = a.id_candidate' : ''}
        ${where}
      `;
      const countResult = await db.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0]?.total || 0);

      return res.json({
        success: true,
        data: result.rows,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          count: result.rows.length,
        },
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao listar applications', errorId });
    }
  }
);

/**
 * GET /api/v1/applications/ids
 *
 * Retorna todos os IDs de applications que correspondem aos filtros.
 * Endpoint otimizado para operações em lote ("Selecionar Todos" no frontend).
 *
 * @route GET /api/v1/applications/ids
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @queryparam {string} [template] - Filtra por nome do template (ILIKE, parcial)
 * @queryparam {number} [subregional] - Filtra por ID da subregional
 * @queryparam {string} [step] - Filtra por nome da etapa atual (ILIKE, parcial)
 * @queryparam {string} [stepStatus] - Filtra por status da etapa (hired, reproved, standby, etc.)
 * @queryparam {string} [statusApplication] - Filtra por status da candidatura
 * @queryparam {string} [statusAulaTeste] - 'pendente' - candidatos em etapa Aula Teste sem booking ativo
 * @queryparam {string} [statusProva] - 'pendente' | 'agendado' | 'compareceu' | 'faltou' | 'cancelado' - status da prova teorica
 * @queryparam {string} [search] - Busca por CPF ou nome do candidato (min 2 caracteres)
 *
 * @returns {Object} 200 - Lista de IDs
 * @returns {boolean} success - Sempre true em sucesso
 * @returns {number[]} data - Array de IDs de candidaturas
 * @returns {number} total - Quantidade total de IDs retornados
 *
 * @example
 * // Request
 * GET /api/v1/applications/ids?template=Professor&stepStatus=hired
 *
 * // Response 200
 * {
 *   "success": true,
 *   "data": [1, 2, 3, 45, 67],
 *   "total": 5
 * }
 *
 * @note Sem limite de resultados - retorna todos os IDs correspondentes.
 *       Para datasets muito grandes (>10k), considerar paginar no frontend.
 */
router.get(
  '/ids',
  requireAuth,
  requireRecrutamento,
  [
    query('template').optional().isString(),
    query('subregional').optional().isInt(),
    query('step').optional().isString(),
    query('stepStatus').optional().isString(),
    query('statusApplication').optional().isString(),
    query('statusAulaTeste').optional().isIn(['pendente']),
    query('statusProva').optional().isIn(['pendente', 'agendado', 'compareceu', 'faltou', 'cancelado']),
    query('tag').optional().isString(),
    query('search').optional().isString().isLength({ min: 2 }),
    query('cvSearch').optional().isString().isLength({ min: 2, max: 200 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const {
        template,
        subregional,
        step,
        stepStatus,
        statusApplication,
        statusAulaTeste,
        statusProva,
        tag,
        search,
        cvSearch,
      } = req.query;

      let where = 'WHERE 1=1';
      const params = [];
      let idx = 1;

      if (template) {
        where += ` AND js.template_name ILIKE $${idx}`;
        params.push(`%${template}%`);
        idx++;
      }

      if (subregional) {
        where += ` AND js.id_subregional = $${idx}`;
        params.push(subregional);
        idx++;
      }

      if (step) {
        where += ` AND a.current_step_name ILIKE $${idx}`;
        params.push(`%${step}%`);
        idx++;
      }

      if (stepStatus) {
        where += ` AND a.current_step_status = $${idx}`;
        params.push(stepStatus);
        idx++;
      }

      if (statusApplication) {
        where += ` AND a.status_application = $${idx}`;
        params.push(statusApplication);
        idx++;
      }

      // Filtro por status aula teste (pendente = na etapa Aula Teste ou Entrevista sem booking ativo)
      if (statusAulaTeste === 'pendente') {
        where += ` AND a.current_step_name IN ('Aula Teste', 'Entrevista')`;
        where += ` AND NOT EXISTS (
          SELECT 1 FROM booking b
          WHERE b.id_application_gupy = a.id_application_gupy
          AND b.status_booking NOT IN ('cancelado', 'faltou')
        )`;
      }

      // Filtro por status prova teorica (suporta tipos: prova_teorica, prova_online_professor, prova_online_pedagogo, prova_online_monitor)
      if (statusProva) {
        if (statusProva === 'pendente') {
          // Pendente = na etapa Agendamento de Prova Online e sem event_application ativo
          where += ` AND a.current_step_name = 'Agendamento de Prova Online'`;
          where += ` AND NOT EXISTS (
            SELECT 1 FROM event_application ea
            JOIN event e ON e.id = ea.id_event
            WHERE ea.id_application = a.id
            AND e.type LIKE 'prova_%'
            AND ea.status IN ('agendado', 'compareceu')
          )`;
        } else {
          // Outros status: agendado, compareceu, faltou (qualquer etapa)
          where += ` AND EXISTS (
            SELECT 1 FROM event_application ea
            JOIN event e ON e.id = ea.id_event
            WHERE ea.id_application = a.id
            AND e.type LIKE 'prova_%'
            AND ea.status = $${idx}
          )`;
          params.push(statusProva);
          idx++;
        }
      }

      // Filtro por tag (JSONB contains)
      if (tag) {
        where += ` AND a.tags @> $${idx}::jsonb`;
        params.push(JSON.stringify([tag]));  // Tags are strings, not objects
        idx++;
      }

      // Search requires join with candidate table
      const needsCandidate = !!search || !!cvSearch;

      if (search) {
        where += ` AND (c.cpf ILIKE $${idx} OR c.nome ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }

      // Busca textual no cv_data (cada palavra separada por espaço = AND lógico)
      // Note: no include=candidate guard needed - needsCandidate adds JOIN dynamically
      if (cvSearch) {
        const result = appendCvSearchWhere(cvSearch, where, params, idx);
        if (result.termCount === 0) {
          return res.status(400).json({
            success: false,
            error: 'cvSearch deve conter pelo menos um termo de busca valido',
          });
        }
        ({ where } = result);
      }

      const queryStr = `
        SELECT a.id
        FROM application a
        JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
        ${needsCandidate ? 'JOIN candidate c ON c.id = a.id_candidate' : ''}
        ${where}
        ORDER BY a.id
      `;

      const result = await db.query(queryStr, params);
      const ids = result.rows.map(r => r.id);

      return res.json({
        success: true,
        data: ids,
        total: ids.length,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET /ids] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar IDs', errorId });
    }
  }
);

// ============================================================================
// SYNC COM GUPY
// ============================================================================

/**
 * POST /api/v1/applications/sync
 *
 * Dispara sync on-demand com Gupy
 */
router.post(
  '/sync',
  requireAuth,
  requireRecrutamento,
  [
    query('template').optional().isString(),
    query('subregional').optional().isInt(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const filters = {
        template: req.query.template,
        subregional: req.query.subregional ? parseInt(req.query.subregional) : undefined,
      };

      const result = await syncApplications(filters);

      return res.json({
        success: true,
        message: 'Sync concluido',
        data: result,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application Sync] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao sincronizar com Gupy', errorId });
    }
  }
);

// ============================================================================
// TAGS (for filter dropdown)
// ============================================================================

/**
 * GET /api/v1/applications/tags
 *
 * Lista tags unicas com contagem de uso.
 * Usado para popular dropdown de filtro por tag no frontend.
 *
 * @route GET /api/v1/applications/tags
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @returns {Object} 200 - Lista de tags
 * @returns {boolean} success - Sempre true em sucesso
 * @returns {Object[]} tags - Array de tags com contagem
 * @returns {string} tags[].name - Nome da tag
 * @returns {number} tags[].count - Quantidade de applications com essa tag
 */
router.get(
  '/tags',
  requireAuth,
  requireRecrutamento,
  async (req, res) => {
    try {
      // Tags are stored as string arrays ["tag1", "tag2"], not objects
      const result = await db.query(`
        SELECT tag as name, COUNT(*)::int as count
        FROM application, jsonb_array_elements_text(tags) as tag
        WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
        GROUP BY tag
        ORDER BY count DESC, name ASC
      `);

      return res.json({
        success: true,
        tags: result.rows,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET /tags] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar tags', errorId });
    }
  }
);

// ============================================================================
// JOB STEPS (for dynamic filter)
// ============================================================================

const gupyService = require('../services/gupyService');
const { body } = require('express-validator');

/**
 * GET /api/v1/applications/job-steps
 *
 * Lista etapas de jobs. Comportamento varia conforme parâmetro template:
 *
 * - COM template: Busca etapas configuradas na Gupy para o job daquele template
 * - SEM template: Retorna todas as etapas únicas existentes nas applications do banco
 *
 * @route GET /api/v1/applications/job-steps
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @queryparam {string} [template] - Nome do template (opcional, busca parcial ILIKE)
 *
 * @returns {Object} 200 - Lista de etapas do job
 * @returns {boolean} success - Sempre true em sucesso
 * @returns {Object[]} data - Array de etapas do job
 * @returns {string} data[].name - Nome da etapa
 * @returns {number} [data[].position] - Posição da etapa (apenas com template)
 * @returns {string} [data[].type] - Tipo da etapa (apenas com template)
 *
 * @returns {Object} 404 - Template não encontrado (apenas quando template é especificado)
 * @returns {boolean} success - false
 * @returns {string} error - "Nenhum job encontrado com este template"
 *
 * @example
 * // Request COM template
 * GET /api/v1/applications/job-steps?template=Professor
 *
 * // Response 200
 * {
 *   "success": true,
 *   "data": [
 *     { "name": "Triagem", "position": 1, "type": "screening" },
 *     { "name": "Aula Teste", "position": 2, "type": "test_class" },
 *     { "name": "Contratação", "position": 3, "type": "hiring" }
 *   ]
 * }
 *
 * @example
 * // Request SEM template (todas etapas únicas)
 * GET /api/v1/applications/job-steps
 *
 * // Response 200
 * {
 *   "success": true,
 *   "data": [
 *     { "id": "aula-teste", "name": "Aula Teste" },
 *     { "id": "contratacao", "name": "Contratação" },
 *     { "id": "triagem", "name": "Triagem" }
 *   ]
 * }
 */
router.get(
  '/job-steps',
  requireAuth,
  requireRecrutamento,
  [query('template').optional().isString()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { template } = req.query;

      // Se não tem template, retorna todas as etapas únicas das applications
      if (!template) {
        try {
          const result = await db.query(`
            SELECT DISTINCT current_step_name as name
            FROM application
            WHERE current_step_name IS NOT NULL AND current_step_name != ''
            ORDER BY current_step_name ASC
          `);

          // Defensive check for unexpected database response
          if (!result || !Array.isArray(result.rows)) {
            const errorId = generateErrorId();
            console.error(`[Application GET job-steps] ${errorId} Unexpected database response`);
            return res.status(500).json({
              success: false,
              error: 'Resposta inesperada do banco de dados',
              errorId
            });
          }

          const steps = result.rows
            .filter(row => row && row.name)
            .map(row => ({
              id: row.name.toLowerCase().replace(/\s+/g, '-'),
              name: row.name,
            }));

          return res.json({
            success: true,
            data: steps,
          });
        } catch (dbError) {
          const errorId = generateErrorId();
          console.error(`[Application GET job-steps] ${errorId} Database error:`, dbError);
          return res.status(500).json({
            success: false,
            error: 'Erro ao buscar etapas do banco de dados',
            errorId
          });
        }
      }

      // Com template: comportamento original - busca na Gupy
      // Find a job_subregional with this template to get the job_gupy_id
      const jobResult = await db.query(
        `SELECT id_job_gupy FROM job_subregional WHERE template_name ILIKE $1 AND id_job_gupy IS NOT NULL LIMIT 1`,
        [`%${template}%`]
      );

      if (jobResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Nenhum job encontrado com este template',
        });
      }

      const jobId = jobResult.rows[0].id_job_gupy;

      // Fetch steps from Gupy
      const steps = await gupyService.listJobSteps(jobId);

      return res.json({
        success: true,
        data: steps,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET job-steps] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar etapas do job', errorId });
    }
  }
);

// ============================================================================
// EMAIL TEMPLATES (Gupy API v1)
// ============================================================================

/**
 * GET /api/v1/applications/email-templates
 *
 * Lista templates de email disponiveis na Gupy
 */
router.get(
  '/email-templates',
  requireAuth,
  requireRecrutamento,
  async (req, res) => {
    try {
      const templates = await gupyService.listEmailTemplates();

      return res.json({
        success: true,
        data: templates,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET email-templates] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar templates de email', errorId });
    }
  }
);

/**
 * GET /api/v1/applications/email-templates/:id
 *
 * Busca um template de email especifico
 */
router.get(
  '/email-templates/:id',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id } = req.params;
      const template = await gupyService.getEmailTemplate(id);

      return res.json({
        success: true,
        data: template,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET email-template] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar template de email', errorId });
    }
  }
);

/**
 * GET /api/v1/applications/common-steps
 *
 * Get steps that are common to ALL jobs of the selected applications.
 * Used by BulkMoveModal to show only valid step options.
 *
 * IMPORTANT: This route MUST be defined BEFORE /:id to avoid being captured
 * by the parameter route.
 *
 * @route GET /api/v1/applications/common-steps
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @queryparam {string} applicationIds - Comma-separated list of application IDs
 *
 * @returns {Object} 200 - List of common steps
 * @returns {boolean} success - Always true on success
 * @returns {Object[]} data - Array of steps common to all jobs
 * @returns {string} data[].name - Step name
 * @returns {number} data[].count - Number of jobs that have this step
 */
router.get(
  '/common-steps',
  requireAuth,
  requireRecrutamento,
  [
    query('applicationIds')
      .notEmpty()
      .withMessage('applicationIds is required'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { applicationIds } = req.query;
      const ids = applicationIds.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id));

      if (ids.length === 0) {
        return res.status(400).json({ success: false, error: 'applicationIds inválidos' });
      }

      // Get unique job IDs for the selected applications
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const jobsResult = await db.query(
        `SELECT DISTINCT js.id_job_gupy
         FROM application a
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE a.id IN (${placeholders}) AND js.id_job_gupy IS NOT NULL`,
        ids
      );

      if (jobsResult.rows.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // Fetch steps for each job from Gupy API
      const jobStepsMap = new Map(); // stepName -> set of jobIds that have it
      const failedJobs = [];

      for (const row of jobsResult.rows) {
        try {
          const steps = await gupyService.listJobSteps(row.id_job_gupy);
          for (const step of steps) {
            if (!jobStepsMap.has(step.name)) {
              jobStepsMap.set(step.name, new Set());
            }
            jobStepsMap.get(step.name).add(row.id_job_gupy);
          }
        } catch (err) {
          console.error(`[common-steps] Error fetching steps for job ${row.id_job_gupy}:`, err.message);
          failedJobs.push(row.id_job_gupy);
        }
      }

      // Filter to only steps that are in ALL successfully fetched jobs
      const successfulJobs = jobsResult.rows.length - failedJobs.length;
      const commonSteps = [];

      for (const [name, jobIds] of jobStepsMap) {
        if (jobIds.size === successfulJobs) {
          commonSteps.push({ name, count: jobIds.size });
        }
      }

      // Sort alphabetically for consistent display
      commonSteps.sort((a, b) => a.name.localeCompare(b.name));

      const response = { success: true, data: commonSteps };
      if (failedJobs.length > 0) {
        response.warning = `Não foi possível buscar etapas de ${failedJobs.length} job(s). Os resultados podem estar incompletos.`;
      }

      return res.json(response);
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[common-steps] ${errorId} Error:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar etapas comuns', errorId });
    }
  }
);

/**
 * GET /api/v1/applications/:id
 *
 * Busca application por ID
 */
router.get(
  '/:id',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt(),
    query('include').optional().isString(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id } = req.params;
      const includeCandidate = req.query.include === 'candidate';

      let selectFields = `
        a.id,
        a.id_application_gupy,
        a.id_job_subregional,
        a.current_step_id,
        a.current_step_name,
        a.current_step_status,
        a.status_application,
        a.step_updated_at AS current_step_started_at,
        a.gupy_synced_at,
        a.created_at,
        a.tags,
        js.job_name,
        js.template_name,
        js.id_job_gupy,
        sr.nome_subregional
      `;

      if (includeCandidate) {
        selectFields += `,
          c.id AS candidate_id,
          c.nome AS candidate_nome,
          c.cpf AS candidate_cpf,
          c.email AS candidate_email,
          c.telefone AS candidate_telefone
        `;
      }

      const queryStr = `
        SELECT ${selectFields}
        FROM application a
        JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
        LEFT JOIN subregional sr ON sr.id_subregional = js.id_subregional
        ${includeCandidate ? 'JOIN candidate c ON c.id = a.id_candidate' : ''}
        WHERE a.id = $1
      `;

      const result = await db.query(queryStr, [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Application nao encontrada' });
      }

      return res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application GET :id] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar application', errorId });
    }
  }
);

// ============================================================================
// BATCH ACTIONS (Send Email)
// ============================================================================

/**
 * POST /api/v1/applications/send-email
 *
 * Envia email em massa para applications selecionadas.
 * Returns immediately with actionId for status polling.
 *
 * Body:
 * - applicationIds: Array de IDs de application (local, nao Gupy)
 * - templateId: ID do template de email Gupy
 *
 * @returns {Object} 202 - Action queued
 * @returns {boolean} success - Always true on success
 * @returns {string} actionId - UUID for status polling via GET /actions/:actionId/status
 * @returns {number} queued - Number of items queued
 */
router.post(
  '/send-email',
  requireAuth,
  requireRecrutamento,
  [
    body('applicationIds').isArray({ min: 1 }).withMessage('applicationIds deve ser um array com pelo menos 1 ID'),
    body('applicationIds.*').isInt().withMessage('Cada applicationId deve ser um numero inteiro'),
    body('templateId').isInt().withMessage('templateId deve ser um numero inteiro'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { applicationIds, templateId, templateName } = req.body;
      const result = await batchAction.emailBatch(applicationIds, templateId, {}, req.user, templateName);

      return res.status(202).json({
        success: true,
        message: result.queued > 0
          ? `Ação em processamento: ${result.queued} email(s)${result.skipped > 0 ? ` (${result.skipped} ignorado(s))` : ''}`
          : result.message,
        ...result,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Application Send Email] ${errorId} Erro:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao enviar emails', errorId });
    }
  }
);

// ============================================================================
// BULK ACTIONS (Tags, Move, Reprove)
// ============================================================================

/**
 * GET /api/v1/applications/actions/:actionId/status
 *
 * Get status of an async batch action.
 *
 * @route GET /api/v1/applications/actions/:actionId/status
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @param {string} actionId - UUID of the action
 *
 * @returns {Object} 200 - Action status
 */
router.get(
  '/actions/:actionId/status',
  requireAuth,
  requireRecrutamento,
  async (req, res) => {
    try {
      const { actionId } = req.params;
      const status = batchAction.getActionStatus(actionId);

      if (!status) {
        return res.status(404).json({ success: false, error: 'Ação não encontrada' });
      }

      return res.json({ success: true, data: status });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[action-status] ${errorId} Error:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar status', errorId });
    }
  }
);

/**
 * POST /api/v1/applications/actions/bulk-tags
 *
 * Add or remove tags from applications in bulk.
 *
 * @route POST /api/v1/applications/actions/bulk-tags
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @body {number[]} applicationIds - Array of application IDs
 * @body {string} tagName - Name of the tag
 * @body {string} action - 'add' or 'remove'
 *
 * @returns {Object} 202 - Action queued
 */
router.post(
  '/actions/bulk-tags',
  requireAuth,
  requireRecrutamento,
  [
    body('applicationIds').isArray({ min: 1 }).withMessage('applicationIds deve ser um array'),
    body('tagName').notEmpty().withMessage('tagName é obrigatório'),
    body('action').isIn(['add', 'remove']).withMessage('action deve ser add ou remove'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { applicationIds, tagName, action } = req.body;
      const result = await batchAction.tagBatch(applicationIds, tagName, action, req.user);

      return res.status(202).json({
        success: true,
        message: result.queued > 0
          ? `Ação em processamento: ${result.queued} tag(s)`
          : result.message,
        ...result,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Bulk Tags] ${errorId} Error:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao processar tags', errorId });
    }
  }
);

/**
 * POST /api/v1/applications/actions/bulk-move
 *
 * Move applications to a target step in bulk.
 *
 * @route POST /api/v1/applications/actions/bulk-move
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @body {number[]} applicationIds - Array of application IDs
 * @body {string} targetStepName - Name of the target step
 * @body {boolean} [applyToSameTemplate=false] - Apply to same-template applications
 *
 * @returns {Object} 202 - Action queued
 */
router.post(
  '/actions/bulk-move',
  requireAuth,
  requireRecrutamento,
  [
    body('applicationIds').isArray({ min: 1 }).withMessage('applicationIds deve ser um array'),
    body('targetStepName').notEmpty().withMessage('targetStepName é obrigatório'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { applicationIds, targetStepName, applyToSameTemplate = false } = req.body;
      const result = await batchAction.moveBatch(applicationIds, targetStepName, applyToSameTemplate, req.user);

      return res.status(202).json({
        success: true,
        message: result.queued > 0
          ? `Ação em processamento: ${result.queued} candidatura(s)${result.additionalProcessed > 0 ? ` (+${result.additionalProcessed} relacionadas)` : ''}`
          : result.message,
        ...result,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Bulk Move] ${errorId} Error:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao mover candidaturas', errorId });
    }
  }
);

/**
 * POST /api/v1/applications/actions/bulk-reprove
 *
 * Reprove applications in bulk with a disapproval reason.
 *
 * @route POST /api/v1/applications/actions/bulk-reprove
 * @access Private (requireAuth, requireRecrutamento)
 *
 * @body {number[]} applicationIds - Array of application IDs
 * @body {string} reason - Disapproval reason (Gupy enum)
 * @body {string} [notes=''] - Optional notes
 * @body {boolean} [applyToSameTemplate=false] - Apply to same-template applications
 *
 * @returns {Object} 202 - Action queued
 */
router.post(
  '/actions/bulk-reprove',
  requireAuth,
  requireRecrutamento,
  [
    body('applicationIds').isArray({ min: 1 }).withMessage('applicationIds deve ser um array'),
    body('reason').notEmpty().withMessage('reason é obrigatório'),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { applicationIds, reason, notes = '', applyToSameTemplate = false } = req.body;
      const result = await batchAction.reproveBatch(applicationIds, reason, notes, applyToSameTemplate, req.user);

      return res.status(202).json({
        success: true,
        message: result.queued > 0
          ? `Ação em processamento: ${result.queued} candidatura(s)${result.additionalProcessed > 0 ? ` (+${result.additionalProcessed} relacionadas)` : ''}`
          : result.message,
        ...result,
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[Bulk Reprove] ${errorId} Error:`, error);
      return res.status(500).json({ success: false, error: 'Erro ao reprovar candidaturas', errorId });
    }
  }
);

module.exports = router;
