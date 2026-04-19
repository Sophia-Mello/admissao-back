const express = require('express');
const router = express.Router();
const { query, param, body, validationResult } = require('express-validator');
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const gupyService = require('../services/gupyService');
const { logEvent } = require('../services/eventLogService');

router.get('/unidades/:id/applications', requireAuth, requireRecrutamento,
  [
    param('id').isInt(),
    query('cpf').optional().isLength({ min: 11, max: 11 }),
    query('step').optional().isString(),
    query('email').optional().isEmail(),
    query('name').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { id } = req.params;
      const { cpf, step, email, name } = req.query;

      if (!cpf) {
        return res.status(400).json({ success: false, error: 'CPF é obrigatório para busca' });
      }

      const jobsResult = await db.query(
        `SELECT js.id_job_gupy FROM job_unidade ju
         JOIN job_subregional js ON js.id_job_subregional = ju.id_job_subregional
         WHERE ju.id_unidade = $1 AND js.ativo = true`,
        [id]
      );

      if (jobsResult.rows.length === 0) {
        return res.json({ success: true, data: [], message: 'Nenhuma vaga ativa para esta unidade' });
      }

      const allApplications = [];
      for (const job of jobsResult.rows) {
        try {
          // step pode ser: undefined (busca todos), string específica (ex: 'Aula Teste')
          const applications = await gupyService.searchApplicationsByJobAndCpf(
            job.id_job_gupy,
            cpf,
            step || null  // null = busca em todos os steps
          );
          if (applications && applications.length > 0) {
            allApplications.push(...applications.map(app => ({ ...app, id_job_gupy: job.id_job_gupy })));
          }
        } catch (gupyError) {
          console.error(`[Gupy] Erro job ${job.id_job_gupy}:`, gupyError.message);
        }
      }

      return res.json({ success: true, data: allApplications });
    } catch (error) {
      console.error('[Gupy GET applications] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidatos' });
    }
  }
);

router.get('/jobs/:jobId/applications/:applicationId', requireAuth, requireRecrutamento,
  [param('jobId').notEmpty(), param('applicationId').notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { jobId, applicationId } = req.params;
      const application = await gupyService.getApplicationByJob(jobId, applicationId);
      if (!application) return res.status(404).json({ success: false, error: 'Candidatura não encontrada' });
      return res.json({ success: true, data: application });
    } catch (error) {
      console.error('[Gupy GET application] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar candidatura' });
    }
  }
);

router.get('/jobs', requireAuth, requireRecrutamento, [query('status').optional().isString()],
  async (req, res) => {
    try {
      const { status } = req.query;
      const jobs = await gupyService.getJobs({ status });
      return res.json({ success: true, data: jobs });
    } catch (error) {
      console.error('[Gupy GET jobs] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar vagas do Gupy' });
    }
  }
);

router.get('/templates', requireAuth, requireRecrutamento,
  [query('perPage').optional().isInt({ min: 1, max: 200 }), query('fields').optional().isString()],
  async (req, res) => {
    try {
      const { perPage = 100, fields = 'all' } = req.query;
      const templates = await gupyService.listJobTemplates({ perPage: String(perPage), fields });

      // Filter templates where COD customField has a non-empty value
      const filteredTemplates = (templates.results || []).filter(template => {
        if (!template.customFields || !Array.isArray(template.customFields)) {
          return false;
        }
        const codField = template.customFields.find(cf => cf.label === 'COD');
        return codField && codField.value && codField.value.trim() !== '';
      });

      return res.json({ success: true, data: filteredTemplates });
    } catch (error) {
      console.error('[Gupy GET templates] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao buscar templates do Gupy' });
    }
  }
);

router.post('/applications/:applicationId/move-step', requireAuth, requireRecrutamento,
  [
    param('applicationId').notEmpty().withMessage('applicationId é obrigatório'),
    body('job_id').notEmpty().withMessage('job_id é obrigatório'),
    body('step_name').notEmpty().withMessage('step_name é obrigatório').isString().withMessage('step_name deve ser uma string'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { applicationId } = req.params;
      const { step_name, job_id } = req.body;
      const result = await gupyService.moveApplication(job_id, applicationId, step_name);
      req._eventLogged = true;
      logEvent({
        eventType: 'admin.move_step',
        entityType: 'application',
        entityId: String(applicationId),
        actorType: 'admin',
        actorId: req.user?.id?.toString() || null,
        actorName: req.user?.nome || null,
        metadata: { applicationId, jobId: job_id, fromStep: null, toStep: step_name },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('[Gupy POST move-step] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao mover candidato no Gupy' });
    }
  }
);

module.exports = router;
