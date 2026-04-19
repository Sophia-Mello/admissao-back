/**
 * Subregional Routes
 *
 * Rotas para listagem de subregionais e suas unidades
 * Usado pelo frontend para selecionar onde criar vagas
 */

const express = require('express');
const { param, validationResult } = require('express-validator');
const router = express.Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');

/**
 * GET /api/v1/admin/subregional
 *
 * Lista todas as subregionais
 */
router.get('/', requireAuth, requireRecrutamento, async (req, res) => {
  try {
    // Usa views locais (subregional, regional)
    const result = await db.query(`
      SELECT
        s.id_subregional,
        s.nome_subregional,
        s.id_regional,
        r.nome_regional,
        s.endereco
      FROM subregional s
      LEFT JOIN regional r ON r.id_regional = s.id_regional
      WHERE s.ativo = true
      ORDER BY r.nome_regional, s.nome_subregional
    `);

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error('[Subregional GET] Erro:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao listar subregionais',
    });
  }
});

/**
 * GET /api/v1/admin/subregional/:id/unidades
 *
 * Lista unidades de uma subregional
 */
router.get('/:id/unidades', requireAuth, requireRecrutamento,
  [param('id').isInt({ min: 1 }).withMessage('ID deve ser um numero inteiro positivo')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;

      // Usa view local (unidade)
      const result = await db.query(`
        SELECT
          id_unidade,
          nome_unidade,
          email_unidade_agendador,
          cidade,
          uf
        FROM unidade
        WHERE id_subregional = $1 AND ativo = true
        ORDER BY nome_unidade
      `, [id]);

      return res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      console.error('[Subregional GET unidades] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao listar unidades da subregional',
      });
    }
  }
);

module.exports = router;
