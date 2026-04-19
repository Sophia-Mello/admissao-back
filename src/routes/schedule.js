const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const { logEvent } = require('../services/eventLogService');

router.get('/', requireAuth, requireRecrutamento,
  [query('id_unidade').optional().isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { id_unidade } = req.query;
      // Cast slot_size to text to return as string instead of interval object
      const baseQuery = `SELECT id_config, id_unidade, morning_start_at, morning_end_at,
        afternoon_start_at, afternoon_end_at, slot_size::text as slot_size,
        d_rule_start, d_rule_end, active, created_at, updated_at, valid_from, valid_until
        FROM schedule_config`;
      const result = id_unidade
        ? await db.query(`${baseQuery} WHERE id_unidade = $1 AND active = true LIMIT 1`, [id_unidade])
        : await db.query(`${baseQuery} WHERE id_unidade IS NULL AND active = true LIMIT 1`);
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Configuração não encontrada' });
      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[Schedule GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar configuração' });
    }
  }
);

router.get('/all', requireAuth, requireRecrutamento, async (req, res) => {
  try {
    // Cast slot_size to text to return as string instead of interval object
    const result = await db.query(`
      SELECT sc.id_config, sc.id_unidade, sc.morning_start_at, sc.morning_end_at,
        sc.afternoon_start_at, sc.afternoon_end_at, sc.slot_size::text as slot_size,
        sc.d_rule_start, sc.d_rule_end, sc.active, sc.created_at, sc.updated_at,
        sc.valid_from, sc.valid_until, u.nome_unidade
      FROM schedule_config sc
      LEFT JOIN unidade u ON u.id_unidade = sc.id_unidade
      WHERE sc.active = true
      ORDER BY sc.id_unidade NULLS FIRST`);
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[Schedule GET ALL] Erro:', error.message);
    return res.status(500).json({ success: false, error: 'Erro ao listar configurações' });
  }
});

router.put('/', requireAuth, requireRecrutamento,
  [
    body('id_unidade').optional({ nullable: true }).isInt(),
    body('morning_start_at').optional({ nullable: true }).matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('morning_end_at').optional({ nullable: true }).matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('afternoon_start_at').optional({ nullable: true }).matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('afternoon_end_at').optional({ nullable: true }).matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('slot_size').optional().matches(/^\d{2}:\d{2}:\d{2}$/),
    body('d_rule_start').optional().isInt({ min: 0 }),
    body('d_rule_end').optional().isInt({ min: 1 }),
    body('valid_from').optional({ nullable: true }).isISO8601(),
    body('valid_until').optional({ nullable: true }).isISO8601(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { id_unidade, morning_start_at, morning_end_at, afternoon_start_at, afternoon_end_at, slot_size, d_rule_start, d_rule_end, valid_from, valid_until } = req.body;
      const existing = await db.query(`SELECT id_config FROM schedule_config WHERE ${id_unidade ? 'id_unidade = $1' : 'id_unidade IS NULL'} AND active = true`, id_unidade ? [id_unidade] : []);
      let result;
      if (existing.rows.length > 0) {
        result = await db.query(`UPDATE schedule_config SET morning_start_at = COALESCE($1, morning_start_at), morning_end_at = COALESCE($2, morning_end_at), afternoon_start_at = COALESCE($3, afternoon_start_at), afternoon_end_at = COALESCE($4, afternoon_end_at), slot_size = COALESCE($5, slot_size), d_rule_start = COALESCE($6, d_rule_start), d_rule_end = COALESCE($7, d_rule_end), valid_from = $8, valid_until = $9, updated_at = NOW() WHERE id_config = $10 RETURNING *`,
          [morning_start_at, morning_end_at, afternoon_start_at, afternoon_end_at, slot_size, d_rule_start, d_rule_end, valid_from || null, valid_until || null, existing.rows[0].id_config]);
      } else {
        // For new unit configs, merge with global config as defaults
        let defaults = {
          morning_start_at: '08:00:00',
          morning_end_at: '12:00:00',
          afternoon_start_at: '13:00:00',
          afternoon_end_at: '17:00:00',
          slot_size: '00:40:00',
          d_rule_start: 1,
          d_rule_end: 30,
        };

        // If creating unit-specific config, fetch global config for defaults
        if (id_unidade) {
          const globalConfig = await db.query(
            `SELECT morning_start_at, morning_end_at, afternoon_start_at, afternoon_end_at,
                    slot_size::text as slot_size, d_rule_start, d_rule_end
             FROM schedule_config WHERE id_unidade IS NULL AND active = true LIMIT 1`
          );
          if (globalConfig.rows.length > 0) {
            const g = globalConfig.rows[0];
            defaults = {
              morning_start_at: g.morning_start_at || defaults.morning_start_at,
              morning_end_at: g.morning_end_at || defaults.morning_end_at,
              afternoon_start_at: g.afternoon_start_at || defaults.afternoon_start_at,
              afternoon_end_at: g.afternoon_end_at || defaults.afternoon_end_at,
              slot_size: g.slot_size || defaults.slot_size,
              d_rule_start: g.d_rule_start ?? defaults.d_rule_start,
              d_rule_end: g.d_rule_end ?? defaults.d_rule_end,
            };
          }
        }

        result = await db.query(`INSERT INTO schedule_config (id_unidade, morning_start_at, morning_end_at, afternoon_start_at, afternoon_end_at, slot_size, d_rule_start, d_rule_end, valid_from, valid_until, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true) RETURNING *`,
          [id_unidade || null, morning_start_at || defaults.morning_start_at, morning_end_at || defaults.morning_end_at, afternoon_start_at || defaults.afternoon_start_at, afternoon_end_at || defaults.afternoon_end_at, slot_size || defaults.slot_size, d_rule_start ?? defaults.d_rule_start, d_rule_end ?? defaults.d_rule_end, valid_from || null, valid_until || null]);
      }
      req._eventLogged = true;
      logEvent({
        eventType: 'admin.schedule_updated',
        entityType: 'schedule_config',
        entityId: String(result.rows[0].id_unidade || 'global'),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { idUnidade: result.rows[0].id_unidade, changes: Object.keys(req.body) },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[Schedule PUT] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao salvar configuração' });
    }
  }
);

router.delete('/:id_unidade', requireAuth, requireRecrutamento,
  [param('id_unidade').isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const result = await db.query(`DELETE FROM schedule_config WHERE id_unidade = $1 RETURNING id_config`, [req.params.id_unidade]);
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Configuração não encontrada' });
      return res.json({ success: true, message: 'Configuração removida' });
    } catch (error) {
      console.error('[Schedule DELETE] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao remover configuração' });
    }
  }
);

module.exports = router;
