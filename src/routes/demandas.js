/**
 * Demandas Routes - Gestão de Demandas
 *
 * Endpoints for viewing open teaching demands, managing metadata (tags, observações, SLA),
 * and finding candidates (internal mobility + selection process) to fill them.
 *
 * - GET /                              → List open demands (consolidated by materia+unidade)
 * - PATCH /:cod_materia/:id_unidade/metadata → Update tags/observação for a demand
 * - GET /subregionais                  → List subregionais
 * - GET /unidades                      → List unidades
 * - GET /disciplinas                   → Distinct disciplines in vw_demandas (for filter)
 * - GET /horarios                      → Schedule slots for a demand's turmas
 * - GET /mobilidade-interna            → Employees who could fill a demand
 * - GET /colaborador/:id/atribuicoes   → Active assignments for an employee
 * - GET /candidatos                    → Candidates from selection process
 */

const express = require('express');
const router = express.Router();
const { query, param, body, validationResult } = require('express-validator');
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireDemandas } = require('../middleware/rbac');

function generateErrorId() {
  return `ERR-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Parâmetros inválidos',
      details: errors.array(),
    });
  }
  next();
};

// ─── GET /api/v1/demandas ─────────────────────────────────────────
// Lista demandas abertas consolidadas por (cod_materia, id_unidade).
// Joins with demanda_metadata for tags, observação, SLA.
// RBAC: admin/recrutamento veem tudo; coordenador filtra por id_unidade.
router.get(
  '/',
  requireAuth,
  requireDemandas,
  [
    query('subregional').optional().isInt(),
    query('unidade').optional().isInt(),
    query('cod_materia').optional().isInt(),
    query('tag').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { subregional, unidade, cod_materia, tag, limit = 50, offset = 0 } = req.query;

      let where = 'WHERE v.cod_materia IS NOT NULL AND v.nome_materia IS NOT NULL';
      const params = [];
      let idx = 1;

      // RBAC: coordenador sees only their unit
      if (req.user.role === 'coordenador') {
        if (!req.user.id_unidade) {
          return res.status(403).json({ success: false, error: 'Coordenador sem unidade atribuida' });
        }
        where += ` AND v.id_unidade = $${idx++}`;
        params.push(req.user.id_unidade);
      } else {
        if (unidade) {
          where += ` AND v.id_unidade = $${idx++}`;
          params.push(parseInt(unidade));
        }
        if (subregional) {
          where += ` AND v.id_subregional = $${idx++}`;
          params.push(parseInt(subregional));
        }
      }

      if (cod_materia) {
        where += ` AND v.cod_materia = $${idx++}`;
        params.push(parseInt(cod_materia));
      }

      if (tag) {
        where += ` AND dm.tags @> $${idx++}::jsonb`;
        params.push(JSON.stringify([tag]));
      }

      const countParams = [...params];

      params.push(parseInt(limit));
      params.push(parseInt(offset));

      const dataQuery = `
        SELECT v.cod_materia, v.nome_materia, v.id_unidade, v.nome_unidade,
               v.id_subregional, v.nome_subregional,
               v.total_aulas_necessarias, v.total_aulas_atribuidas, v.total_aulas_abertas,
               v.turnos,
               COALESCE(dm.tags, '[]'::jsonb) AS tags,
               dm.observacao,
               dm.first_seen_at,
               dm.closed_at
        FROM vw_demandas v
        LEFT JOIN demanda_metadata dm ON dm.cod_materia = v.cod_materia AND dm.id_unidade = v.id_unidade
        ${where}
        ORDER BY v.nome_subregional, v.nome_unidade, v.total_aulas_abertas DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `;

      const countQuery = `
        SELECT COUNT(*) AS total
        FROM vw_demandas v
        LEFT JOIN demanda_metadata dm ON dm.cod_materia = v.cod_materia AND dm.id_unidade = v.id_unidade
        ${where}
      `;

      const [dataResult, countResult] = await Promise.all([
        db.query(dataQuery, params),
        db.query(countQuery, countParams),
      ]);

      return res.json({
        success: true,
        data: dataResult.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar demandas', errorId });
    }
  }
);

// ─── PATCH /api/v1/demandas/:cod_materia/:id_unidade/metadata ─────
// Update tags and/or observação for a specific demand.
// Upserts demanda_metadata row.
router.patch(
  '/:cod_materia/:id_unidade/metadata',
  requireAuth,
  requireDemandas,
  [
    param('cod_materia').isInt(),
    param('id_unidade').isInt(),
    body('tags').optional().isArray(),
    body('tags.*').optional().isString(),
    body('observacao').optional({ nullable: true }).isString(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const codMateria = parseInt(req.params.cod_materia);
      const idUnidade = parseInt(req.params.id_unidade);
      const { tags, observacao } = req.body;

      if (tags === undefined && observacao === undefined) {
        return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
      }

      // Determine closed_at based on tags
      let closedAtExpr = 'demanda_metadata.closed_at';
      if (tags !== undefined) {
        closedAtExpr = tags.includes('Concluída')
          ? 'COALESCE(demanda_metadata.closed_at, NOW())'
          : 'NULL';
      }

      const tagsJson = tags !== undefined ? JSON.stringify(tags) : null;
      const obsValue = observacao !== undefined ? observacao : null;

      const result = await db.query(`
        INSERT INTO demanda_metadata (cod_materia, id_unidade, tags, observacao, first_seen_at)
        VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), $4, NOW())
        ON CONFLICT (cod_materia, id_unidade)
        DO UPDATE SET
          tags = CASE WHEN $3::jsonb IS NOT NULL THEN $3::jsonb ELSE demanda_metadata.tags END,
          observacao = CASE WHEN $5::boolean THEN $4 ELSE demanda_metadata.observacao END,
          closed_at = ${closedAtExpr},
          updated_at = NOW()
        RETURNING *
      `, [codMateria, idUnidade, tagsJson, obsValue, observacao !== undefined]);

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[PATCH /demandas/:cod_materia/:id_unidade/metadata] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar metadata', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/tags ─────────────────────────────────────
// Unique tags used across all demanda_metadata rows, with usage counts.
router.get(
  '/tags',
  requireAuth,
  requireDemandas,
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT tag AS name, COUNT(*)::int AS count
        FROM demanda_metadata, jsonb_array_elements_text(tags) AS tag
        WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
        GROUP BY tag
        ORDER BY count DESC, name ASC
      `);
      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/tags] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar tags', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/subregionais ────────────────────────────
// All subregionais that have units with id_empresa=1 (sourced from rh_sistema_prod).
router.get(
  '/subregionais',
  requireAuth,
  requireDemandas,
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT DISTINCT s.id_subregional, s.nome_subregional
        FROM rh_sistema_prod.subregional s
        JOIN rh_sistema_prod.unidade u ON u.id_subregional = s.id_subregional
        WHERE u.id_empresa = 1 AND u.ativo = TRUE
        ORDER BY s.nome_subregional
      `);
      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/subregionais] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar subregionais', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/unidades ────────────────────────────────
// All unidades with id_empresa=1 (sourced from rh_sistema_prod).
// Optional subregional filter.
router.get(
  '/unidades',
  requireAuth,
  requireDemandas,
  [query('subregional').optional().isInt()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { subregional } = req.query;
      let where = 'WHERE u.id_empresa = 1 AND u.ativo = TRUE';
      const params = [];

      if (subregional) {
        where += ' AND u.id_subregional = $1';
        params.push(parseInt(subregional));
      }

      const result = await db.query(`
        SELECT u.id_unidade, u.nome_unidade, u.id_subregional, s.nome_subregional
        FROM rh_sistema_prod.unidade u
        JOIN rh_sistema_prod.subregional s ON s.id_subregional = u.id_subregional
        ${where}
        ORDER BY u.nome_unidade
      `, params);

      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/unidades] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar unidades', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/disciplinas ─────────────────────────────
// Distinct disciplines present in vw_demandas (for filter dropdown).
router.get(
  '/disciplinas',
  requireAuth,
  requireDemandas,
  async (req, res) => {
    try {
      let where = 'WHERE cod_materia IS NOT NULL AND nome_materia IS NOT NULL';
      const params = [];
      let idx = 1;

      if (req.user.role === 'coordenador') {
        if (!req.user.id_unidade) {
          return res.status(403).json({ success: false, error: 'Coordenador sem unidade atribuida' });
        }
        where += ` AND id_unidade = $${idx++}`;
        params.push(req.user.id_unidade);
      }

      const result = await db.query(`
        SELECT DISTINCT cod_materia, nome_materia
        FROM vw_demandas
        ${where}
        ORDER BY nome_materia
      `, params);

      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/disciplinas] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar disciplinas', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/horarios ────────────────────────────────
// Per-turma schedule detail for a demand (discipline + unit).
// Returns each turma with aulas needed/assigned/open and time slots.
// Only turmas with aulas_abertas > 0 are returned.
router.get(
  '/horarios',
  requireAuth,
  requireDemandas,
  [
    query('id_unidade').notEmpty().isInt(),
    query('cod_materia').notEmpty().isInt(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id_unidade, cod_materia } = req.query;

      const result = await db.query(`
        WITH periodo_atual AS (
          SELECT MAX(id_periodo_letivo) AS id_periodo_letivo FROM rh_sistema_prod.turma
        ),
        turmas_materia AS (
          SELECT
            t.id_turma,
            t.turno,
            t.nome_turma,
            t.id_template_horario,
            CASE WHEN m.eh_recomposicao THEN mm.numero_aulas * 2 ELSE mm.numero_aulas END AS aulas_necessarias,
            mm.id_materia
          FROM rh_sistema_prod.turma t
          CROSS JOIN periodo_atual pa
          JOIN rh_sistema_prod.matriz_curricular mc ON mc.id_matriz_curricular = t.id_matriz_curricular
          JOIN rh_sistema_prod.matriz_materias mm ON mm.id_matriz_curricular = mc.id_matriz_curricular
          JOIN rh_sistema_prod.materia m ON m.id_materia = mm.id_materia
          WHERE t.id_unidade = $1
            AND m.cod_materia = $2
            AND t.id_periodo_letivo = pa.id_periodo_letivo
        ),
        atrib AS (
          SELECT a.id_turma, mm.id_materia, SUM(a.quantidade_aulas)::INTEGER AS aulas_atribuidas
          FROM rh_sistema_prod.atribuicao a
          JOIN rh_sistema_prod.matriz_materias mm ON mm.id_matriz_materias = a.id_matriz_materias
          WHERE (a.data_fim IS NULL OR a.data_fim >= CURRENT_DATE)
          GROUP BY a.id_turma, mm.id_materia
        )
        SELECT
          tm.turno,
          tm.nome_turma,
          tm.aulas_necessarias::INTEGER,
          COALESCE(at.aulas_atribuidas, 0) AS aulas_atribuidas,
          (tm.aulas_necessarias - COALESCE(at.aulas_atribuidas, 0))::INTEGER AS aulas_abertas,
          (SELECT json_agg(sub ORDER BY sub.dia_semana, sub.hora_ini)
           FROM (
             SELECT DISTINCT ah.dia_semana, ah.hora_ini::TEXT AS hora_ini, ah.hora_fim::TEXT AS hora_fim
             FROM rh_sistema_prod.aulas_horario ah
             WHERE ah.id_template_horario = tm.id_template_horario
               AND ah.is_intervalo = false
           ) sub
          ) AS horarios
        FROM turmas_materia tm
        LEFT JOIN atrib at ON at.id_turma = tm.id_turma AND at.id_materia = tm.id_materia
        WHERE (tm.aulas_necessarias - COALESCE(at.aulas_atribuidas, 0)) > 0
        ORDER BY tm.turno, tm.nome_turma
      `, [parseInt(id_unidade), parseInt(cod_materia)]);

      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/horarios] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar horarios', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/mobilidade-interna ──────────────────────
// CLT employees who can fill a demand. Deduplicates by CPF (multi-unit employees)
// and checks schedule conflicts against the demand's time slots.
router.get(
  '/mobilidade-interna',
  requireAuth,
  requireDemandas,
  [
    query('cod_materia').notEmpty().isInt(),
    query('id_unidade').notEmpty().isInt(),
    query('id_subregional').notEmpty().isInt(),
    query('turno').optional().isString(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { cod_materia, id_unidade, id_subregional, turno } = req.query;

      // $1=cod_materia, $2=id_unidade, $3=id_subregional, $4=turno (optional)
      const params = [parseInt(cod_materia), parseInt(id_unidade), parseInt(id_subregional)];
      let turnoParam = '';
      let scheduleFilter = '';

      if (turno) {
        params.push(turno);
        turnoParam = `AND t.turno = $4`;
        // Filter: employee must have schedule availability for at least 1 demand slot
        scheduleFilter = `
          AND ((SELECT COUNT(*) FROM demand_slots) - COALESCE(conf.slots_ocupados, 0)) > 0
        `;
      }

      const result = await db.query(`
        WITH compativel AS (
          SELECT DISTINCT mc.cod_materia_origem
          FROM materia_compatibilidade mc
          WHERE mc.cod_materia_destino = $1 AND mc.ativo = TRUE
        ),
        periodo_atual AS (
          SELECT MAX(id_periodo_letivo) AS id_periodo_letivo FROM rh_sistema_prod.turma
        ),
        -- All time slots for the demand's turmas (to check schedule conflicts)
        demand_slots AS (
          SELECT DISTINCT ah.dia_semana, ah.hora_ini, ah.hora_fim
          FROM rh_sistema_prod.turma t
          CROSS JOIN periodo_atual pa
          JOIN rh_sistema_prod.aulas_horario ah ON ah.id_template_horario = t.id_template_horario
          WHERE t.id_unidade = $2::INTEGER
            ${turnoParam}
            AND t.id_periodo_letivo = pa.id_periodo_letivo
            AND ah.is_intervalo = false
        ),
        -- Sum active hours per CPF (dedup across all units)
        horas_por_cpf AS (
          SELECT c.cpf, SUM(a.quantidade_aulas) AS total_aulas
          FROM rh_sistema_prod.colaborador c
          JOIN rh_sistema_prod.atribuicao a ON a.id_colaborador = c.id_colaborador
          WHERE (a.data_fim IS NULL OR a.data_fim >= CURRENT_DATE) AND c.data_desligamento IS NULL
            AND c.cpf IS NOT NULL AND c.cpf != ''
          GROUP BY c.cpf
        ),
        -- Schedule conflicts per CPF: how many demand time slots the person is busy
        conflitos_por_cpf AS (
          SELECT c.cpf, COUNT(DISTINCT (ah.dia_semana, ah.hora_ini)) AS slots_ocupados
          FROM rh_sistema_prod.colaborador c
          JOIN rh_sistema_prod.atribuicao a ON a.id_colaborador = c.id_colaborador
          JOIN rh_sistema_prod.grade_horario gh ON gh.id_atribuicao = a.id_atribuicao
          JOIN rh_sistema_prod.aulas_horario ah ON ah.id_aulas_horario = gh.id_aulas_horario
          WHERE (a.data_fim IS NULL OR a.data_fim >= CURRENT_DATE) AND c.data_desligamento IS NULL
            AND c.cpf IS NOT NULL AND c.cpf != ''
            AND (ah.dia_semana, ah.hora_ini) IN (SELECT dia_semana, hora_ini FROM demand_slots)
          GROUP BY c.cpf
        )
        SELECT
          c.cpf,
          MIN(c.id_colaborador) AS id_colaborador,
          MAX(c.nome) AS nome,
          MAX(CASE WHEN c.email IS NOT NULL AND c.email != '' THEN c.email END) AS email,
          MAX(CASE WHEN c.celular IS NOT NULL AND c.celular != '' THEN c.celular END) AS celular,
          MAX(CASE WHEN c.telefone IS NOT NULL AND c.telefone != '' THEN c.telefone END) AS telefone,
          -- Aggregate units for deduplication
          ARRAY_AGG(DISTINCT c.id_unidade) AS unidade_ids,
          ARRAY_AGG(DISTINCT u.nome_unidade) AS unidade_nomes,
          MAX(tv.nome_vinculo) AS tipo_vinculo,
          COALESCE(MAX(h.total_aulas), 0)::INTEGER AS aulas_ativas,
          (40 - COALESCE(MAX(h.total_aulas), 0))::INTEGER AS aulas_disponiveis,
          -- Schedule availability
          (SELECT COUNT(*) FROM demand_slots)::INTEGER AS total_horarios_demanda,
          ((SELECT COUNT(*) FROM demand_slots) - COALESCE(MAX(conf.slots_ocupados), 0))::INTEGER AS horarios_disponiveis,
          -- Compatible subjects (across all units for this CPF)
          ARRAY(
            SELECT DISTINCT m2.nome_materia
            FROM rh_sistema_prod.colaborador c2
            JOIN rh_sistema_prod.colaborador_materia cm2 ON cm2.id_colaborador = c2.id_colaborador
            JOIN rh_sistema_prod.materia m2 ON m2.id_materia = cm2.id_materia
            WHERE c2.cpf = c.cpf AND c2.data_desligamento IS NULL AND cm2.ativo = TRUE
              AND m2.cod_materia IN (SELECT cod_materia_origem FROM compativel)
          ) AS materias_compativeis,
          -- Priority: 0=same unit, 1=same subregional, 2=other
          CASE
            WHEN BOOL_OR(c.id_unidade = $2::INTEGER) THEN 0
            WHEN BOOL_OR(u.id_subregional = $3::INTEGER) THEN 1
            ELSE 2
          END AS prioridade
        FROM rh_sistema_prod.colaborador c
        JOIN rh_sistema_prod.unidade u ON u.id_unidade = c.id_unidade
        JOIN rh_sistema_prod.tipo_vinculo tv ON tv.id_tipo_vinculo = c.id_tipo_vinculo
        JOIN rh_sistema_prod.colaborador_materia cm ON cm.id_colaborador = c.id_colaborador
        JOIN rh_sistema_prod.materia m ON m.id_materia = cm.id_materia
        JOIN compativel comp ON comp.cod_materia_origem = m.cod_materia
        LEFT JOIN horas_por_cpf h ON h.cpf = c.cpf
        LEFT JOIN conflitos_por_cpf conf ON conf.cpf = c.cpf
        WHERE c.professor_flag = TRUE
          AND c.data_desligamento IS NULL
          AND cm.ativo = TRUE
          AND u.id_empresa = 1
          AND c.id_tipo_vinculo = 47  -- CLT only
          AND c.cpf IS NOT NULL AND c.cpf != ''
          AND COALESCE(h.total_aulas, 0) < 40
          ${scheduleFilter}
        GROUP BY c.cpf
        ORDER BY prioridade,
                 horarios_disponiveis DESC,
                 aulas_disponiveis DESC
        LIMIT 100
      `, params);

      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/mobilidade-interna] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar mobilidade interna', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/colaborador/:id/atribuicoes ─────────────
// Active assignments for an employee (finds all records with same CPF for multi-unit).
// Includes schedule (horarios) for each assignment.
router.get(
  '/colaborador/:id/atribuicoes',
  requireAuth,
  requireDemandas,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });

      // Find all colaborador IDs with the same CPF
      const cpfResult = await db.query(`
        SELECT c2.id_colaborador, c2.nome, c2.id_unidade, u.nome_unidade
        FROM rh_sistema_prod.colaborador c1
        JOIN rh_sistema_prod.colaborador c2 ON c2.cpf = c1.cpf
          AND c2.data_desligamento IS NULL
          AND c2.cpf IS NOT NULL AND c2.cpf != ''
        JOIN rh_sistema_prod.unidade u ON u.id_unidade = c2.id_unidade
        WHERE c1.id_colaborador = $1
        ORDER BY c2.id_unidade
      `, [id]);

      if (cpfResult.rows.length === 0) {
        return res.json({ success: true, data: { colaboradores: [], atribuicoes: [] } });
      }

      const colaboradorIds = cpfResult.rows.map(r => r.id_colaborador);

      // Fetch active atribuicoes with schedule
      const atribResult = await db.query(`
        SELECT
          a.id_atribuicao,
          a.id_colaborador,
          a.quantidade_aulas,
          a.data_inicio,
          t.nome_turma,
          t.turno,
          t.id_unidade,
          u.nome_unidade,
          m.nome_materia,
          m.cod_materia,
          COALESCE(
            json_agg(
              json_build_object(
                'dia_semana', ah.dia_semana,
                'hora_ini', ah.hora_ini::TEXT,
                'hora_fim', ah.hora_fim::TEXT
              ) ORDER BY ah.dia_semana, ah.hora_ini
            ) FILTER (WHERE ah.id_aulas_horario IS NOT NULL),
            '[]'
          ) AS horarios
        FROM rh_sistema_prod.atribuicao a
        JOIN rh_sistema_prod.turma t ON t.id_turma = a.id_turma
        JOIN rh_sistema_prod.unidade u ON u.id_unidade = t.id_unidade
        JOIN rh_sistema_prod.matriz_materias mm ON mm.id_matriz_materias = a.id_matriz_materias
        JOIN rh_sistema_prod.materia m ON m.id_materia = mm.id_materia
        LEFT JOIN rh_sistema_prod.grade_horario gh ON gh.id_atribuicao = a.id_atribuicao
        LEFT JOIN rh_sistema_prod.aulas_horario ah ON ah.id_aulas_horario = gh.id_aulas_horario
          AND ah.is_intervalo = false
        WHERE (a.data_fim IS NULL OR a.data_fim >= CURRENT_DATE)
          AND a.id_colaborador = ANY($1::INTEGER[])
        GROUP BY a.id_atribuicao, a.id_colaborador, a.quantidade_aulas, a.data_inicio,
                 t.nome_turma, t.turno, t.id_unidade, u.nome_unidade,
                 m.nome_materia, m.cod_materia
        ORDER BY u.nome_unidade, t.turno, t.nome_turma
      `, [colaboradorIds]);

      return res.json({
        success: true,
        data: {
          colaboradores: cpfResult.rows,
          atribuicoes: atribResult.rows,
        },
      });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/colaborador/:id/atribuicoes] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar atribuicoes', errorId });
    }
  }
);

// ─── GET /api/v1/demandas/candidatos ──────────────────────────────
// Candidatos do processo seletivo que podem suprir a demanda.
// Match via CV ILIKE (case-insensitive text search by materia name words).
// Distance = subregional da candidatura vs subregional da demanda.
router.get(
  '/candidatos',
  requireAuth,
  requireDemandas,
  [
    query('cod_materia').optional().isInt(),
    query('nome_materia').notEmpty().isString().isLength({ min: 3 }),
    query('id_subregional').notEmpty().isInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { nome_materia, id_subregional, limit = 50, offset = 0 } = req.query;

      // Build search terms from nome_materia (split words, take first 3 meaningful)
      const terms = nome_materia.trim().split(/\s+/).filter(w => w.length > 2).slice(0, 3);
      if (terms.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // Build CV ILIKE conditions (all terms must match)
      let cvWhere = '';
      const params = [];
      let idx = 1;

      for (const term of terms) {
        const escaped = term.replace(/[%_\\]/g, '\\$&');
        cvWhere += ` AND c.cv_data::text ILIKE $${idx}`;
        params.push(`%${escaped}%`);
        idx++;
      }

      params.push(parseInt(id_subregional));
      const subregIdx = idx++;
      params.push(parseInt(limit));
      const limitIdx = idx++;
      params.push(parseInt(offset));
      const offsetIdx = idx++;

      const result = await db.query(`
        SELECT
          c.id          AS candidate_id,
          c.nome,
          c.email,
          c.telefone,
          json_agg(json_build_object(
            'current_step_name', a.current_step_name,
            'id_subregional', js.id_subregional,
            'nome_subregional', sr.nome_subregional,
            'distancia', CASE WHEN js.id_subregional = $${subregIdx} THEN 0 ELSE 1 END
          ) ORDER BY CASE WHEN js.id_subregional = $${subregIdx} THEN 0 ELSE 1 END, a.id DESC) AS candidaturas,
          MIN(CASE WHEN js.id_subregional = $${subregIdx} THEN 0 ELSE 1 END) AS distancia
        FROM application a
        JOIN candidate c ON c.id = a.id_candidate
        JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
        LEFT JOIN rh_sistema_prod.subregional sr ON sr.id_subregional = js.id_subregional
        WHERE a.status_application = 'inProgress'
          AND NOT EXISTS (
            SELECT 1 FROM pre_employee pe
            WHERE pe.id_application_gupy = a.id_application_gupy
          )
          AND c.cv_data IS NOT NULL
          ${cvWhere}
        GROUP BY c.id, c.nome, c.email, c.telefone
        ORDER BY distancia, c.nome
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params);

      return res.json({ success: true, data: result.rows });
    } catch (error) {
      const errorId = generateErrorId();
      console.error(`[GET /demandas/candidatos] ${errorId}`, error);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidatos', errorId });
    }
  }
);

module.exports = router;
