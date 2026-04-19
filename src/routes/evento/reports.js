/**
 * Reports Routes - Sistema de Ocorrências (Fiscalização)
 *
 * Endpoints for fiscal to create and view occurrence reports:
 * POST /reports - Create occurrence report with Gupy integration
 * GET /reports/:id_event_application - List occurrences for a candidate
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const db = require('../../../db');
const { requireAuth } = require('../../middleware/authMiddleware');
const { requireFiscalProva } = require('../../middleware/rbac');
const gupyService = require('../../services/gupyService');

// Environment variables for Gupy integration
const GUPY_TAG_ALERT = process.env.GUPY_TAG_ALERT || 'alerta-prova-online';
const GUPY_TAG_ELIMINATED = process.env.GUPY_TAG_ELIMINATED || 'eliminado-prova-online';
const GUPY_TAG_TECHNICAL = process.env.GUPY_TAG_TECHNICAL || 'problema-tecnico-prova-online';
const GUPY_STAGE_PROVA_ONLINE = process.env.GUPY_STAGE_PROVA_ONLINE_SCHEDULE || 'Agendamento de Prova Online';

/**
 * POST /reports - Create occurrence report
 *
 * Creates an event_report record and integrates with Gupy:
 * - type="alert" -> adds tag "alerta-prova-online" in Gupy
 * - type="eliminatory" -> adds tag "eliminado-prova-online" in Gupy
 * - Adds comment to Gupy timeline with the description
 */
router.post('/',
  requireAuth,
  requireFiscalProva,
  [
    body('id_event_application').isInt(),
    body('type').isIn(['alert', 'eliminatory', 'technical']),
    body('description').isString().isLength({ min: 5, max: 2000 }),
  ],
  async (req, res) => {
    const client = await db.getClient();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id_event_application, type, description } = req.body;

      await client.query('BEGIN');

      // Get event_application with candidate and job info
      const appResult = await client.query(
        `SELECT
           ea.id,
           ea.id_event,
           e.date,
           e.time_start,
           e.room,
           a.id_application_gupy,
           js.id_job_gupy,
           c.nome AS candidate_name
         FROM event_application ea
         JOIN event e ON e.id = ea.id_event
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         JOIN job_subregional js ON js.id_job_subregional = a.id_job_subregional
         WHERE ea.id = $1`,
        [id_event_application]
      );

      if (appResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Inscrição não encontrada' });
      }

      const app = appResult.rows[0];

      // Create event_report (registered_by stores user email as text)
      const reportResult = await client.query(
        `INSERT INTO event_report (id_event_application, type, description, registered_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id_event_application, type, description, req.user.email]
      );

      const report = reportResult.rows[0];

      // Determine tag based on type
      let gupyTag;
      if (type === 'alert') {
        gupyTag = GUPY_TAG_ALERT;
      } else if (type === 'eliminatory') {
        gupyTag = GUPY_TAG_ELIMINATED;
      } else {
        gupyTag = GUPY_TAG_TECHNICAL;
      }

      let tagCreated = false;
      let commentCreated = false;
      let candidateMoved = false;

      // For technical issues: cancel event_application and move candidate back
      if (type === 'technical') {
        // Update event_application status to 'cancelado'
        await client.query(
          `UPDATE event_application SET status = 'cancelado' WHERE id = $1`,
          [id_event_application]
        );
        console.log(`[Reports] Event application ${id_event_application} cancelado por problema técnico`);

        // Move candidate back to "Agendamento de Prova Online" in Gupy
        try {
          await gupyService.moveApplication(
            app.id_job_gupy,
            app.id_application_gupy,
            GUPY_STAGE_PROVA_ONLINE
          );
          candidateMoved = true;
          console.log(`[Reports] Candidato ${app.candidate_name} movido para "${GUPY_STAGE_PROVA_ONLINE}"`);
        } catch (moveErr) {
          console.error(`[Reports] Falha ao mover candidato ${app.candidate_name}:`, moveErr.message);
        }
      }

      // Add tag in Gupy
      try {
        await gupyService.addTag(
          app.id_job_gupy,
          app.id_application_gupy,
          gupyTag
        );
        tagCreated = true;
        console.log(`[Reports] Tag "${gupyTag}" added to ${app.candidate_name}`);
      } catch (gupyErr) {
        console.error(`[Reports] Failed to add tag to ${app.candidate_name}:`, gupyErr.message);
      }

      // Add comment in Gupy timeline
      const timestamp = new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
      });
      const typeLabel = type === 'alert' ? 'ALERTA' : type === 'eliminatory' ? 'ELIMINATÓRIA' : 'PROBLEMA TÉCNICO';
      const commentText = `[${timestamp}] Sala ${app.room} - ${typeLabel}: ${description}`;

      try {
        await gupyService.addTimelineComment(
          app.id_job_gupy,
          app.id_application_gupy,
          commentText
        );
        commentCreated = true;
        console.log(`[Reports] Comment added to ${app.candidate_name}'s timeline`);
      } catch (gupyErr) {
        console.error(`[Reports] Failed to add comment to ${app.candidate_name}:`, gupyErr.message);
      }

      // Update report with Gupy integration status
      await client.query(
        `UPDATE event_report
         SET gupy_tag_created = $1, gupy_comment_created = $2
         WHERE id = $3`,
        [tagCreated, commentCreated, report.id]
      );

      await client.query('COMMIT');

      console.log(`[Reports] Ocorrência ${type} criada para ${app.candidate_name} por ${req.user.email}`);

      return res.status(201).json({
        success: true,
        id: report.id,
        gupy_tag: gupyTag,
        gupy_tag_created: tagCreated,
        gupy_comment_added: commentCreated,
        candidate_moved: candidateMoved,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Reports POST] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao criar ocorrência' });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /reports/:id_event_application - List occurrences for a candidate
 *
 * Returns all occurrence reports for a specific event_application.
 */
router.get('/:id_event_application',
  requireAuth,
  requireFiscalProva,
  [param('id_event_application').isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { id_event_application } = req.params;

      // Verify event_application exists
      const appResult = await db.query(
        `SELECT ea.id, c.nome AS candidate_name
         FROM event_application ea
         JOIN application a ON a.id = ea.id_application
         JOIN candidate c ON c.id = a.id_candidate
         WHERE ea.id = $1`,
        [id_event_application]
      );

      if (appResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Inscrição não encontrada' });
      }

      // Get all reports (registered_by is text with user email, no JOIN needed)
      const reportsResult = await db.query(
        `SELECT
           er.id,
           er.type,
           er.description,
           er.gupy_tag_created,
           er.gupy_comment_created,
           er.created_at,
           er.registered_by AS created_by_name
         FROM event_report er
         WHERE er.id_event_application = $1
         ORDER BY er.created_at DESC`,
        [id_event_application]
      );

      return res.json({
        success: true,
        candidate_name: appResult.rows[0].candidate_name,
        reports: reportsResult.rows,
      });
    } catch (error) {
      console.error('[Reports GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar ocorrências' });
    }
  }
);

module.exports = router;
