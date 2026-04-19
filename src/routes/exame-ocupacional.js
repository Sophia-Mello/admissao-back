const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireSalu } = require('../middleware/rbac');
const gupyAdmissionService = require('../services/gupyAdmissionService');
const rhSistemaService = require('../services/rhSistemaService');

// Constantes para status válidos
const VALID_STATUSES = ['pendente', 'agendado', 'compareceu', 'faltou', 'aprovado', 'reprovado'];
const CONCLUDED_STATUSES = ['compareceu', 'faltou', 'aprovado', 'reprovado'];

/**
 * GET / - Lista candidatos com filtros e paginação
 */
router.get('/', requireAuth, requireSalu,
  [
    query('status').optional().isString(),
    query('search').optional().isString(),
    query('cargo').optional().isString(),
    query('empresa').optional().isInt({ min: 1, max: 2 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { status, search, cargo, empresa, limit = 100, offset = 0 } = req.query;

      let whereClause = 'WHERE active = true';
      const params = [];
      let idx = 1;

      // Filtro por status (pode ser múltiplos separados por vírgula)
      if (status) {
        const statusList = status.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
        if (statusList.length > 0) {
          whereClause += ` AND status = ANY($${idx})`;
          params.push(statusList);
          idx++;
        }
      }

      // Busca por nome ou CPF
      if (search) {
        whereClause += ` AND (nome ILIKE $${idx} OR cpf ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }

      // Filtro por cargo
      if (cargo) {
        whereClause += ` AND cargo ILIKE $${idx}`;
        params.push(`%${cargo}%`);
        idx++;
      }

      // Filtro por empresa (1 = Tom, 2 = APG)
      if (empresa) {
        whereClause += ` AND empresa = $${idx}`;
        params.push(empresa);
        idx++;
      }

      // Conta total para paginação
      const countResult = await db.query(
        `SELECT COUNT(*) as total FROM exame_ocupacional_candidato ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total, 10);

      // Busca dados com paginação (inclui dias_no_status = tempo desde última atualização)
      params.push(limit, offset);
      const result = await db.query(
        `SELECT *,
           EXTRACT(DAY FROM (NOW() - COALESCE(updated_at, created_at)))::int AS dias_no_status
         FROM exame_ocupacional_candidato ${whereClause}
         ORDER BY
           CASE status
             WHEN 'pendente' THEN 1
             WHEN 'agendado' THEN 2
             WHEN 'compareceu' THEN 3
             WHEN 'faltou' THEN 4
             WHEN 'aprovado' THEN 5
             WHEN 'reprovado' THEN 6
           END,
           created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        params
      );

      return res.json({
        success: true,
        data: result.rows,
        pagination: { limit, offset, total }
      });
    } catch (error) {
      console.error('[ExameOcupacional GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar candidatos' });
    }
  }
);

/**
 * GET /summary - Retorna contagens por status
 * Aceita filtros opcionais para refletir o estado filtrado da UI
 */
router.get('/summary', requireAuth, requireSalu,
  [
    query('empresa').optional().isInt({ min: 1, max: 2 }).toInt(),
    query('cargo').optional().isString().trim().isLength({ max: 200 }),
    query('search').optional().isString().trim().isLength({ max: 100 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { empresa, cargo, search } = req.query;

      let whereClause = 'WHERE active = true';
      const params = [];
      let idx = 1;

      // Filtro por empresa (1 = Tom, 2 = APG)
      if (empresa) {
        whereClause += ` AND empresa = $${idx}`;
        params.push(empresa);
        idx++;
      }

      // Filtro por cargo
      if (cargo) {
        whereClause += ` AND cargo ILIKE $${idx}`;
        params.push(`%${cargo}%`);
        idx++;
      }

      // Busca por nome ou CPF
      if (search) {
        whereClause += ` AND (nome ILIKE $${idx} OR cpf ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }

      const result = await db.query(`
        SELECT
          status,
          COUNT(*) as count
        FROM exame_ocupacional_candidato
        ${whereClause}
        GROUP BY status
      `, params);

      const detalhado = {};
      for (const status of VALID_STATUSES) {
        detalhado[status] = 0;
      }
      for (const row of result.rows) {
        detalhado[row.status] = parseInt(row.count, 10);
      }

      const pendentes = detalhado.pendente;
      const agendados = detalhado.agendado;
      const concluidos = CONCLUDED_STATUSES.reduce((sum, s) => sum + detalhado[s], 0);

      return res.json({
        success: true,
        data: {
          pendentes,
          agendados,
          concluidos,
          detalhado
        }
      });
    } catch (error) {
      console.error('[ExameOcupacional GET /summary] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao obter resumo' });
    }
  }
);

/**
 * GET /cargos - Lista cargos distintos para filtro
 */
router.get('/cargos', requireAuth, requireSalu,
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT DISTINCT cargo
         FROM exame_ocupacional_candidato
         WHERE active = true AND cargo IS NOT NULL AND cargo != ''
         ORDER BY cargo`
      );
      return res.json({
        success: true,
        data: result.rows.map(r => r.cargo)
      });
    } catch (error) {
      console.error('[ExameOcupacional GET /cargos] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar cargos' });
    }
  }
);

/**
 * GET /export - Exporta candidatos em CSV
 */
router.get('/export', requireAuth, requireSalu,
  [
    query('status').optional().isString(),
    query('search').optional().isString(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { status, search } = req.query;

      let whereClause = 'WHERE active = true';
      const params = [];
      let idx = 1;

      if (status) {
        const statusList = status.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
        if (statusList.length > 0) {
          whereClause += ` AND status = ANY($${idx})`;
          params.push(statusList);
          idx++;
        }
      }

      if (search) {
        whereClause += ` AND (nome ILIKE $${idx} OR cpf ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
      }

      const result = await db.query(
        `SELECT * FROM exame_ocupacional_candidato ${whereClause} ORDER BY created_at DESC`,
        params
      );

      // Formatar CPF para exibição
      const formatCPF = (cpf) => {
        if (!cpf || cpf.length !== 11) return cpf;
        return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
      };

      // Formatar data para exibição
      const formatDate = (date) => {
        if (!date) return '';
        const d = new Date(date);
        return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      };

      // Formatar empresa para exibição
      const formatEmpresa = (empresa) => {
        if (empresa === 1) return 'Tom';
        if (empresa === 2) return 'APG';
        return 'Tom'; // Default
      };

      // Gerar CSV
      const headers = ['Nome', 'CPF', 'Cargo', 'Empresa', 'PCD', 'Endereco', 'Telefone', 'Email', 'Status', 'Agendado Para', 'Job ID', 'Application ID', 'Criado Em'];
      const rows = result.rows.map(row => [
        `"${(row.nome || '').replace(/"/g, '""')}"`,
        formatCPF(row.cpf),
        `"${(row.cargo || '').replace(/"/g, '""')}"`,
        formatEmpresa(row.empresa),
        row.pcd ? 'Sim' : 'Nao',
        `"${(row.endereco || '').replace(/"/g, '""')}"`,
        row.telefone || '',
        row.email || '',
        row.status,
        row.agendado_para ? formatDate(row.agendado_para) : '',
        row.id_job_gupy,
        row.id_application_gupy,
        formatDate(row.created_at)
      ].join(','));

      const csv = [headers.join(','), ...rows].join('\n');

      // Nome do arquivo com data atual
      const today = new Date().toISOString().split('T')[0];
      const filename = `exames-ocupacionais-${today}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // BOM para UTF-8 (ajuda Excel a reconhecer encoding)
      return res.send('\ufeff' + csv);
    } catch (error) {
      console.error('[ExameOcupacional GET /export] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao exportar CSV' });
    }
  }
);

/**
 * POST /import - Importa batch de candidatos
 * Ignora duplicados baseado em id_admission
 */
router.post('/import', requireAuth, requireSalu,
  [
    body().isArray().withMessage('Body deve ser um array'),
    body('*.nome').notEmpty().withMessage('nome é obrigatório'),
    body('*.cpf').notEmpty().isLength({ min: 11, max: 11 }).withMessage('cpf deve ter 11 dígitos'),
    body('*.idAdmission').notEmpty().withMessage('idAdmission é obrigatório'),
    body('*.empresa').optional().isInt({ min: 1, max: 2 }).withMessage('empresa deve ser 1 (Tom) ou 2 (APG)'),
    body('*.currentStep').optional().isString().withMessage('currentStep deve ser string'),
  ],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const candidatos = req.body;
      if (!Array.isArray(candidatos) || candidatos.length === 0) {
        return res.status(400).json({ success: false, error: 'Array de candidatos vazio' });
      }

      await client.query('BEGIN');

      let importados = 0;
      let duplicados = 0;
      const erros = [];

      for (let i = 0; i < candidatos.length; i++) {
        const c = candidatos[i];
        try {
          // Verificar duplicado por id_admission
          const existing = await client.query(
            `SELECT id_candidato FROM exame_ocupacional_candidato
             WHERE id_admission = $1 AND active = true`,
            [c.idAdmission]
          );

          if (existing.rows.length > 0) {
            duplicados++;
            continue;
          }

          // Inserir novo candidato
          await client.query(`
            INSERT INTO exame_ocupacional_candidato
            (id_admission, nome, cpf, cargo, pcd, endereco, telefone, email, empresa, current_step)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            c.idAdmission,
            c.nome,
            c.cpf.replace(/\D/g, ''), // Remove formatação do CPF
            c.cargo || null,
            c.pcd || false,
            c.endereco || null,
            c.telefone || null,
            c.email || null,
            c.empresa || 1, // Default: 1 (Tom)
            c.currentStep || null
          ]);
          importados++;
        } catch (itemError) {
          erros.push({ index: i, error: itemError.message, candidato: c.nome });
        }
      }

      await client.query('COMMIT');

      return res.status(201).json({
        success: true,
        data: {
          importados,
          duplicados,
          erros
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[ExameOcupacional POST /import] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao importar candidatos' });
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /:id/status - Atualiza status de um candidato
 * Se status = 'agendado', requer agendado_para
 */
router.patch('/:id/status', requireAuth, requireSalu,
  [
    param('id').isInt().toInt(),
    body('status').notEmpty().isIn(VALID_STATUSES).withMessage(`status deve ser um de: ${VALID_STATUSES.join(', ')}`),
    body('agendado_para').optional().isISO8601(),
    body('observacoes').optional().isString().isLength({ max: 2000 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { id } = req.params;
      const { status, agendado_para, observacoes } = req.body;

      // Validação: se status = 'agendado', precisa de agendado_para
      if (status === 'agendado' && !agendado_para) {
        return res.status(400).json({
          success: false,
          error: 'Campo agendado_para é obrigatório quando status = agendado'
        });
      }

      // Se mudando de 'agendado' para outro status, limpar agendado_para
      const clearAgendamento = status !== 'agendado';

      // Usar transação com FOR UPDATE para evitar race condition
      const client = await db.getClient();
      let candidato;
      let previousStatus;

      try {
        await client.query('BEGIN');

        // Buscar status anterior com lock para evitar race condition
        const previousResult = await client.query(
          'SELECT status FROM exame_ocupacional_candidato WHERE id_candidato = $1 AND active = true FOR UPDATE',
          [id]
        );

        if (previousResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: 'Candidato não encontrado' });
        }

        previousStatus = previousResult.rows[0].status;

        // Atualizar status dentro da mesma transação
        const result = await client.query(`
          UPDATE exame_ocupacional_candidato
          SET
            status = $1,
            agendado_para = $2,
            observacoes = COALESCE($3, observacoes),
            updated_at = NOW()
          WHERE id_candidato = $4 AND active = true
          RETURNING *
        `, [
          status,
          clearAgendamento ? null : agendado_para,
          observacoes,
          id
        ]);

        candidato = result.rows[0];
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      } finally {
        client.release();
      }
      const syncStatus = { gupy: null, rh_sistema: null };
      const syncErrors = [];

      // Se status = 'compareceu' ou 'aprovado' e empresa = 1 (Tom), processar ações pós-exame
      // Fix: 'aprovado' também deve ativar o fluxo (movimento Gupy + atualização CLT)
      // Mas se vindo de 'compareceu' para 'aprovado', não executa novamente (já foi executado)
      const shouldRunPostExamFlow = (status === 'compareceu' || status === 'aprovado')
        && candidato.empresa === 1
        && candidato.id_admission
        && previousStatus !== 'compareceu'; // Evita execução duplicada: compareceu → aprovado

      if (shouldRunPostExamFlow) {
        console.log('[ExameOcupacional] Executando fluxo pós-exame:', {
          id_candidato: candidato.id_candidato,
          status,
          previousStatus,
          empresa: candidato.empresa
        });

        // 1. Mover na Gupy Admissão
        try {
          await gupyAdmissionService.moveToProntoSenior(candidato.id_admission);
          syncStatus.gupy = 'success';
          console.log('[ExameOcupacional] Candidato movido para Pronto Senior na Gupy Admissão:', {
            id_candidato: candidato.id_candidato,
            id_admission: candidato.id_admission,
            status_trigger: status
          });
        } catch (gupyError) {
          syncStatus.gupy = 'error';
          syncErrors.push({ api: 'gupy', error: gupyError.message });
          console.error('[ExameOcupacional] Erro ao mover na Gupy Admissão:', {
            id_candidato: candidato.id_candidato,
            id_admission: candidato.id_admission,
            error: gupyError.message
          });
        }

        // 2. Atualizar tipo_vinculo para CLT (47) via API do RH Sistema
        try {
          // Buscar id_colaborador via pre_employee
          const preEmployeeResult = await db.query(
            `SELECT id_colaborador FROM pre_employee
             WHERE id_admission = $1 AND id_colaborador IS NOT NULL`,
            [candidato.id_admission]
          );

          if (preEmployeeResult.rows.length > 0) {
            const idColaborador = preEmployeeResult.rows[0].id_colaborador;
            await rhSistemaService.atualizarTipoVinculo(idColaborador, rhSistemaService.TIPO_VINCULO.CLT);
            syncStatus.rh_sistema = 'success';
            console.log('[ExameOcupacional] tipo_vinculo atualizado para CLT:', {
              id_candidato: candidato.id_candidato,
              id_colaborador: idColaborador,
              status_trigger: status
            });
          } else {
            syncStatus.rh_sistema = 'skipped';
            syncErrors.push({
              api: 'rh_sistema',
              type: 'warning',
              error: 'pre_employee não encontrado - tipo_vinculo não foi atualizado para CLT'
            });
            console.warn('[ExameOcupacional] pre_employee não encontrado para atualizar tipo_vinculo:', {
              id_admission: candidato.id_admission
            });
          }
        } catch (rhError) {
          syncStatus.rh_sistema = 'error';
          syncErrors.push({ api: 'rh_sistema', error: rhError.message });
          console.error('[ExameOcupacional] Erro ao atualizar tipo_vinculo:', {
            id_candidato: candidato.id_candidato,
            id_admission: candidato.id_admission,
            error: rhError.message
          });
        }
      } else if (status === 'compareceu' || status === 'aprovado') {
        // Log quando fluxo pós-exame é pulado para facilitar debugging
        const skipReason = previousStatus === 'compareceu' ? 'já executado em compareceu'
          : candidato.empresa !== 1 ? 'empresa não é Tom (1)'
          : !candidato.id_admission ? 'sem id_admission'
          : 'condição não atendida';
        console.log('[ExameOcupacional] Fluxo pós-exame ignorado:', {
          id_candidato: candidato.id_candidato,
          status,
          previousStatus,
          empresa: candidato.empresa,
          reason: skipReason
        });
      }

      const response = { success: true, data: candidato };
      if (syncStatus.gupy || syncStatus.rh_sistema) {
        response.sync_status = syncStatus;
        if (syncErrors.length > 0) {
          response.sync_errors = syncErrors;
        }
      }
      return res.json(response);
    } catch (error) {
      console.error('[ExameOcupacional PATCH /:id/status] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar status' });
    }
  }
);

/**
 * GET /:id - Busca candidato por ID
 */
router.get('/:id', requireAuth, requireSalu,
  [param('id').isInt().toInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const result = await db.query(
        `SELECT *,
           EXTRACT(DAY FROM (NOW() - COALESCE(updated_at, created_at)))::int AS dias_no_status
         FROM exame_ocupacional_candidato WHERE id_candidato = $1 AND active = true`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Candidato não encontrado' });
      }

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[ExameOcupacional GET /:id] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidato' });
    }
  }
);

/**
 * DELETE /:id - Soft delete de candidato
 */
router.delete('/:id', requireAuth, requireSalu,
  [param('id').isInt().toInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const result = await db.query(
        `UPDATE exame_ocupacional_candidato
         SET active = false, updated_at = NOW()
         WHERE id_candidato = $1 AND active = true
         RETURNING id_candidato`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Candidato não encontrado' });
      }

      return res.json({ success: true, message: 'Candidato removido' });
    } catch (error) {
      console.error('[ExameOcupacional DELETE /:id] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao remover candidato' });
    }
  }
);

module.exports = router;
