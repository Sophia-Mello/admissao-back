const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');

const { optionalAuth } = require('../middleware/authMiddleware');
const {
  getScheduleConfig,
  applyDRulesWithValidity,
  applyValidity,
  paginateByWeek,
  getSlots,
  filterPublicSlots,
  enrichSlotsWithCandidateData
} = require('../lib/slot');

router.get('/',
  optionalAuth,
  [
    query('id_unidade').notEmpty().isInt().withMessage('id_unidade é obrigatório'),
    query('page').optional().isInt({ min: 1 }).withMessage('page deve ser inteiro positivo'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const isAuthenticated = !!req.user;
      const { id_unidade } = req.query;
      const page = req.query.page ? parseInt(req.query.page) : null;

      const config = await getScheduleConfig(id_unidade);
      if (!config) {
        return res.status(404).json({ success: false, error: 'Configuração de horários não encontrada' });
      }

      let range = isAuthenticated ? applyValidity(config) : applyDRulesWithValidity(config);
      if (!range) {
        return res.status(400).json({ success: false, error: 'Período de agendamento não disponível' });
      }

      const pagination = paginateByWeek(range.start_date, range.end_date, page);
      const slots = await getSlots({ id_unidade, start_date: pagination.start_date, end_date: pagination.end_date, config });

      // Enriquecer com dados do candidato apenas para recrutadores autenticados
      const enrichedSlots = isAuthenticated
        ? await enrichSlotsWithCandidateData(slots)
        : slots;
      const filteredSlots = isAuthenticated ? enrichedSlots : filterPublicSlots(slots);

      return res.json({
        success: true,
        config: {
          slot_size: config.slot_size,
          ...(isAuthenticated && {
            morning_start_at: config.morning_start_at, morning_end_at: config.morning_end_at,
            afternoon_start_at: config.afternoon_start_at, afternoon_end_at: config.afternoon_end_at,
            d_rule_start: config.d_rule_start, d_rule_end: config.d_rule_end,
            valid_from: config.valid_from, valid_until: config.valid_until
          })
        },
        pagination: { currentPage: pagination.currentPage, totalPages: pagination.totalPages, week_start: pagination.start_date, week_end: pagination.end_date },
        slots: filteredSlots
      });
    } catch (error) {
      console.error('[Availability] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar disponibilidade' });
    }
  }
);

module.exports = router;
