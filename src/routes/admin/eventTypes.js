/**
 * Event Types Admin Routes
 *
 * CRUD endpoints for managing event types.
 *
 * Routes:
 *   GET    /                    - List all active event types
 *   GET    /:id                 - Get event type by ID
 *   POST   /                    - Create new event type
 *   PUT    /:id                 - Update event type
 *   DELETE /:id                 - Soft delete (ativo = false)
 *   POST   /:id/templates       - Add templates to event type
 *   DELETE /:id/templates/:templateId - Remove template from event type
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const db = require('../../../db');
const { requireAuth } = require('../../middleware/authMiddleware');
const { requireRecrutamento, requireFiscalProva } = require('../../middleware/rbac');
const {
  getAllEventTypes,
  getEventTypeById,
  clearCache,
  generateCodeFromName,
} = require('../../lib/eventTypeResolver');

/**
 * GET /
 * List all active event types with their templates
 * Note: Uses requireFiscalProva to allow fiscal_prova users to read event types
 * for the fiscalization page dropdown filter.
 */
router.get('/', requireAuth, requireFiscalProva, async (req, res) => {
  try {
    const eventTypes = await getAllEventTypes();
    return res.json({ success: true, data: eventTypes });
  } catch (error) {
    console.error('[EventTypes GET] Erro:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao listar tipos de evento',
    });
  }
});

/**
 * GET /:id
 * Get a single event type by ID
 * Note: Uses requireFiscalProva to allow fiscal_prova users to read event types.
 */
router.get(
  '/:id',
  requireAuth,
  requireFiscalProva,
  [param('id').isInt().withMessage('ID deve ser um número inteiro')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const eventType = await getEventTypeById(req.params.id);

      if (!eventType) {
        return res.status(404).json({
          success: false,
          error: 'Tipo de evento não encontrado',
        });
      }

      return res.json({ success: true, data: eventType });
    } catch (error) {
      console.error('[EventTypes GET :id] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao buscar tipo de evento',
      });
    }
  }
);

/**
 * POST /
 * Create a new event type
 */
router.post(
  '/',
  requireAuth,
  requireRecrutamento,
  [
    body('display_name')
      .trim()
      .notEmpty()
      .withMessage('Nome é obrigatório')
      .isLength({ max: 100 })
      .withMessage('Nome deve ter no máximo 100 caracteres'),
    body('calendar_id')
      .optional({ nullable: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage('ID do calendário deve ter no máximo 255 caracteres'),
    body('templates')
      .optional()
      .isArray()
      .withMessage('Templates deve ser um array'),
    body('templates.*.id_template_gupy')
      .optional()
      .notEmpty()
      .withMessage('ID do template é obrigatório'),
    body('templates.*.template_name')
      .optional()
      .trim()
      .isLength({ max: 255 })
      .withMessage('Nome do template deve ter no máximo 255 caracteres'),
  ],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { display_name, calendar_id, templates = [] } = req.body;

      // Generate code from display_name
      const code = generateCodeFromName(display_name);

      if (!code) {
        return res.status(400).json({
          success: false,
          error: 'Nome inválido - não foi possível gerar código',
          code: 'INVALID_NAME',
        });
      }

      await client.query('BEGIN');

      // Check if code already exists (inside transaction to prevent race condition)
      const existingCode = await client.query(
        'SELECT id FROM event_type WHERE code = $1 FOR UPDATE',
        [code]
      );

      if (existingCode.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'Já existe um tipo de evento com este nome',
          code: 'DUPLICATE_CODE',
        });
      }

      // Create event type
      const eventTypeResult = await client.query(
        `INSERT INTO event_type (code, display_name, calendar_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [code, display_name, calendar_id || null]
      );

      const eventType = eventTypeResult.rows[0];

      // Add templates if provided
      if (templates.length > 0) {
        for (const template of templates) {
          // Check if template is already assigned to another event type
          const existingTemplate = await client.query(
            'SELECT id_event_type FROM event_type_template WHERE id_template_gupy = $1',
            [String(template.id_template_gupy)]
          );

          if (existingTemplate.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              success: false,
              error: `Template ${template.id_template_gupy} já está associado a outro tipo de evento`,
              code: 'TEMPLATE_ALREADY_ASSIGNED',
            });
          }

          await client.query(
            `INSERT INTO event_type_template (id_event_type, id_template_gupy, template_name)
             VALUES ($1, $2, $3)`,
            [eventType.id, String(template.id_template_gupy), template.template_name || null]
          );
        }
      }

      await client.query('COMMIT');

      // Clear cache
      clearCache();

      // Fetch complete event type with templates
      const completeEventType = await getEventTypeById(eventType.id);

      console.log(`[EventTypes POST] Tipo criado: ${eventType.code} (ID: ${eventType.id})`);

      return res.status(201).json({
        success: true,
        data: completeEventType,
        message: 'Tipo de evento criado com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[EventTypes POST] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao criar tipo de evento',
      });
    } finally {
      client.release();
    }
  }
);

/**
 * PUT /:id
 * Update an event type
 */
router.put(
  '/:id',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt().withMessage('ID deve ser um número inteiro'),
    body('display_name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Nome não pode ser vazio')
      .isLength({ max: 100 })
      .withMessage('Nome deve ter no máximo 100 caracteres'),
    body('calendar_id')
      .optional({ nullable: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage('ID do calendário deve ter no máximo 255 caracteres'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { display_name, calendar_id } = req.body;

      // Check if event type exists
      const existing = await db.query(
        'SELECT * FROM event_type WHERE id = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Tipo de evento não encontrado',
        });
      }

      // Build update query dynamically
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (display_name !== undefined) {
        const newCode = generateCodeFromName(display_name);

        if (!newCode) {
          return res.status(400).json({
            success: false,
            error: 'Nome inválido - não foi possível gerar código',
            code: 'INVALID_NAME',
          });
        }

        // Check if new code conflicts with another event type
        const codeConflict = await db.query(
          'SELECT id FROM event_type WHERE code = $1 AND id != $2',
          [newCode, id]
        );

        if (codeConflict.rows.length > 0) {
          return res.status(409).json({
            success: false,
            error: 'Já existe outro tipo de evento com este nome',
            code: 'DUPLICATE_CODE',
          });
        }

        updates.push(`display_name = $${paramIndex++}`);
        values.push(display_name);
        updates.push(`code = $${paramIndex++}`);
        values.push(newCode);
      }

      if (calendar_id !== undefined) {
        updates.push(`calendar_id = $${paramIndex++}`);
        values.push(calendar_id || null);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Nenhum campo para atualizar',
        });
      }

      updates.push(`updated_at = NOW()`);
      values.push(id);

      const result = await db.query(
        `UPDATE event_type SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );

      // Clear cache
      clearCache();

      // Fetch complete event type with templates
      const completeEventType = await getEventTypeById(result.rows[0].id);

      console.log(`[EventTypes PUT] Tipo atualizado: ${result.rows[0].code} (ID: ${id})`);

      return res.json({
        success: true,
        data: completeEventType,
        message: 'Tipo de evento atualizado com sucesso',
      });
    } catch (error) {
      console.error('[EventTypes PUT] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao atualizar tipo de evento',
      });
    }
  }
);

/**
 * DELETE /:id
 * Soft delete an event type (set ativo = false)
 */
router.delete(
  '/:id',
  requireAuth,
  requireRecrutamento,
  [param('id').isInt().withMessage('ID deve ser um número inteiro')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;

      const result = await db.query(
        `UPDATE event_type SET ativo = false, updated_at = NOW()
         WHERE id = $1 AND ativo = true
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Tipo de evento não encontrado',
        });
      }

      // Clear cache
      clearCache();

      console.log(`[EventTypes DELETE] Tipo desativado: ${result.rows[0].code} (ID: ${id})`);

      return res.json({
        success: true,
        message: 'Tipo de evento desativado com sucesso',
      });
    } catch (error) {
      console.error('[EventTypes DELETE] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao desativar tipo de evento',
      });
    }
  }
);

/**
 * POST /:id/templates
 * Add templates to an event type
 */
router.post(
  '/:id/templates',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt().withMessage('ID deve ser um número inteiro'),
    body('templates')
      .isArray({ min: 1 })
      .withMessage('Templates deve ser um array com pelo menos 1 item'),
    body('templates.*.id_template_gupy')
      .notEmpty()
      .withMessage('ID do template é obrigatório'),
    body('templates.*.template_name')
      .optional()
      .trim()
      .isLength({ max: 255 }),
  ],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id } = req.params;
      const { templates } = req.body;

      // Check if event type exists
      const eventType = await client.query(
        'SELECT * FROM event_type WHERE id = $1 AND ativo = true',
        [id]
      );

      if (eventType.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Tipo de evento não encontrado',
        });
      }

      await client.query('BEGIN');

      const added = [];
      const skipped = [];

      for (const template of templates) {
        // Check if template is already assigned
        const existing = await client.query(
          'SELECT id_event_type FROM event_type_template WHERE id_template_gupy = $1',
          [String(template.id_template_gupy)]
        );

        if (existing.rows.length > 0) {
          if (existing.rows[0].id_event_type === parseInt(id)) {
            skipped.push({
              id_template_gupy: template.id_template_gupy,
              reason: 'already_in_this_type',
            });
          } else {
            await client.query('ROLLBACK');
            return res.status(409).json({
              success: false,
              error: `Template ${template.id_template_gupy} já está associado a outro tipo de evento`,
              code: 'TEMPLATE_ALREADY_ASSIGNED',
            });
          }
          continue;
        }

        await client.query(
          `INSERT INTO event_type_template (id_event_type, id_template_gupy, template_name)
           VALUES ($1, $2, $3)`,
          [id, String(template.id_template_gupy), template.template_name || null]
        );

        added.push(template.id_template_gupy);
      }

      await client.query('COMMIT');

      // Clear cache
      clearCache();

      // Fetch updated event type
      const completeEventType = await getEventTypeById(id);

      console.log(`[EventTypes POST templates] ${added.length} templates adicionados ao tipo ${id}`);

      return res.json({
        success: true,
        data: completeEventType,
        added,
        skipped,
        message: `${added.length} template(s) adicionado(s)`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[EventTypes POST templates] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao adicionar templates',
      });
    } finally {
      client.release();
    }
  }
);

/**
 * DELETE /:id/templates/:templateId
 * Remove a template from an event type
 *
 * Note: templateId is the row ID (primary key) from event_type_template table,
 * NOT the id_template_gupy. This is more RESTful and matches frontend expectations.
 */
router.delete(
  '/:id/templates/:templateId',
  requireAuth,
  requireRecrutamento,
  [
    param('id').isInt().withMessage('ID do tipo de evento deve ser um número inteiro'),
    param('templateId').isInt().withMessage('ID do template deve ser um número inteiro'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id, templateId } = req.params;

      // Delete by primary key (id) and verify it belongs to the event type
      const result = await db.query(
        `DELETE FROM event_type_template
         WHERE id = $1 AND id_event_type = $2
         RETURNING *`,
        [templateId, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Template não encontrado neste tipo de evento',
        });
      }

      // Clear cache
      clearCache();

      // Fetch updated event type
      const completeEventType = await getEventTypeById(id);

      const deleted = result.rows[0];
      console.log(`[EventTypes DELETE template] Template ${deleted.id_template_gupy} (row ${templateId}) removido do tipo ${id}`);

      return res.json({
        success: true,
        data: completeEventType,
        message: 'Template removido com sucesso',
      });
    } catch (error) {
      console.error('[EventTypes DELETE template] Erro:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Erro ao remover template',
      });
    }
  }
);

module.exports = router;
