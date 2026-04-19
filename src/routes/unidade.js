const express = require('express');
const db = require('../../db');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');

// GET / - List all unidades (admins see all, coordenador sees only their unidade)
// NOTE: Reads from view (rs_admissao_*/unidade → rh_sistema_*/unidade WHERE id_empresa = 1)
router.get('/', requireAuth, async (req, res) => {
  try {
    console.log('📋 GET /unidade - User:', req.user?.email, 'Role:', req.user?.role, 'Unidade:', req.user?.id_unidade);

    if (req.user && req.user.role === 'coordenador') {
      console.log('   → Coordenador: retornando apenas unidade', req.user.id_unidade);
      const r = await db.query('SELECT * FROM unidade WHERE id_unidade = $1', [req.user.id_unidade]);
      return res.json(r.rows);
    }

    console.log('   → Admin: retornando todas as unidades');
    const r = await db.query('SELECT * FROM unidade ORDER BY id_unidade');
    console.log('   → Total de unidades:', r.rows.length);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id - Get single unidade by ID
// NOTE: Reads from view (rs_admissao_*/unidade → rh_sistema_*/unidade WHERE id_empresa = 1)
router.get('/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM unidade WHERE id_unidade = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Unidade not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
