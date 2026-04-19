const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../../db');
const { signToken } = require('../auth');
const { body, query, validationResult } = require('express-validator');
const { validateApplication } = require('../middleware/validateApplication');

const router = express.Router();

const { verifyToken } = require('../auth');

// login
// NOTE: Uses cross-schema FK (rh_sistema_homolog/prod.usuario)
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Email válido é obrigatório'),
  body('senha').notEmpty().withMessage('Senha é obrigatória')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, senha } = req.body;

  try {
    const result = await db.query('SELECT id_usuario, email, senha, role, id_colaborador, id_unidade FROM usuario WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      // Use same error message to prevent user enumeration
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // include unit, collaborator, and email in token so middleware and routes can scope queries
    const token = signToken({ id_usuario: user.id_usuario, email: user.email, role: user.role, id_unidade: user.id_unidade, id_colaborador: user.id_colaborador });
    res.json({
      user: {
        id_usuario: user.id_usuario,
        email: user.email,
        role: user.role,
        id_unidade: user.id_unidade
      },
      token
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// validate token
router.post('/validate', async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body && req.body.token) || null
  if (!token) return res.status(401).json({ error: 'no token' })
  try {
    const decoded = verifyToken(token)
    res.json({ ok: true, decoded })
  } catch (err) {
    res.status(401).json({ error: 'invalid token' })
  }
})

// GET /validate-application - Public validation for booking eligibility
// Uses Gupy API to validate candidate stage and no-show history
router.get('/validate-application',
  [
    query('jobId').notEmpty().withMessage('jobId é obrigatório'),
    query('applicationId').notEmpty().withMessage('applicationId é obrigatório')
  ],
  validateApplication,
  (req, res) => {
    // validateApplication middleware sets req.candidate if valid
    res.json({
      success: true,
      eligible: true,
      candidate: {
        name: req.candidate.name,
        email: req.candidate.email,
        cpf: req.candidate.cpf,
        phone: req.candidate.phone
      },
      job: {
        id_job_gupy: req.candidate.jobId,
        id_job_subregional: req.candidate.id_job_subregional,
        job_name: req.candidate.job_name
      },
      active_booking: req.candidate.active_booking
    });
  }
);

module.exports = router;
