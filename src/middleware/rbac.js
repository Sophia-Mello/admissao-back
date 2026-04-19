const db = require('../../db');

/**
 * ROLES DO SISTEMA:
 * - admin: Acesso total ao sistema
 * - coordenador: Acesso limitado à sua unidade
 * - recrutamento: Acesso apenas a features de R&S (jobs, candidatos, agendamentos)
 * - salu: Acesso apenas a exames ocupacionais
 * - fiscal_prova: Acesso apenas a fiscalização de provas (evento/monitor)
 */

/**
 * Factory function para criar middlewares de autorização por roles.
 * @param {string} name - Nome do middleware (para logs)
 * @param {...string} allowedRoles - Roles permitidas
 * @returns {Function} Middleware Express
 * @throws {Error} Se name ou allowedRoles forem inválidos
 */
function requireRoles(name, ...allowedRoles) {
  // Validação no momento de criação (fail fast)
  if (!name || typeof name !== 'string') {
    throw new Error('requireRoles: name deve ser uma string não vazia');
  }
  if (!allowedRoles.length) {
    throw new Error(`requireRoles(${name}): pelo menos uma role deve ser especificada`);
  }
  const invalidRoles = allowedRoles.filter(r => typeof r !== 'string' || !r);
  if (invalidRoles.length) {
    throw new Error(`requireRoles(${name}): roles inválidas: ${JSON.stringify(invalidRoles)}`);
  }

  return (req, res, next) => {
    const user = req.user;
    console.log(`🔐 RBAC: ${name}`);
    console.log('   User:', user?.username, `[${user?.role}]`);

    if (!user) {
      console.log('❌ RBAC: Usuário não autenticado');
      return res.status(401).json({ error: 'unauthorized' });
    }

    if (allowedRoles.includes(user.role)) {
      console.log(`✅ RBAC: ${user.role} - acesso permitido`);
      return next();
    }

    console.log(`❌ RBAC: Acesso negado - apenas ${allowedRoles.join(', ')} podem acessar este recurso`);
    return res.status(403).json({ error: `forbidden - ${allowedRoles.join(' or ')} only` });
  };
}

// Middlewares simples gerados via factory
const requireAdmin = requireRoles('requireAdmin', 'admin');
const requireRecrutamento = requireRoles('requireRecrutamento', 'admin', 'recrutamento');
const requireSalu = requireRoles('requireSalu', 'admin', 'recrutamento', 'salu');
const requireFiscalProva = requireRoles('requireFiscalProva', 'admin', 'recrutamento', 'fiscal_prova');
const requireDemandas = requireRoles('requireDemandas', 'admin', 'recrutamento', 'coordenador');

// Middleware para exigir role admin OU recrutamento (apenas leitura para recrutamento)
function requireAdminOrRecrutamentoReadOnly(req, res, next) {
  const user = req.user;
  console.log('🔐 RBAC: requireAdminOrRecrutamentoReadOnly');
  console.log('   User:', user?.username, `[${user?.role}]`, 'Method:', req.method);

  if (!user) {
    console.log('❌ RBAC: Usuário não autenticado');
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Admin tem acesso total
  if (user.role === 'admin') {
    console.log('✅ RBAC: Admin - acesso total permitido');
    return next();
  }

  // Recrutamento tem acesso apenas para leitura (GET)
  if (user.role === 'recrutamento' && req.method === 'GET') {
    console.log('✅ RBAC: Recrutamento - acesso de leitura permitido');
    return next();
  }

  console.log(`❌ RBAC: Acesso negado - recrutamento pode apenas ler (GET)`);
  return res.status(403).json({ error: 'forbidden - read only for recrutamento' });
}

// require the user to be admin OR coordenador of the unidade related to resource
async function requireUnitOrAdmin(req, res, next) {
  const user = req.user;
  console.log('🔐 RBAC: requireUnitOrAdmin');
  console.log('   User:', user?.username, `[${user?.role}]`, user?.id_unidade ? `Unidade: ${user.id_unidade}` : '');
  
  if (!user) {
    console.log('❌ RBAC: Usuário não autenticado');
    return res.status(401).json({ error: 'unauthorized' });
  }
  
  if (user.role === 'admin') {
    console.log('✅ RBAC: Admin - acesso permitido');
    return next();
  }
  
  let targetUnit = req.body.id_unidade || req.params.id_unidade;
  console.log('   Target unit:', targetUnit);
  
  // If we have id_turma but no id_unidade, try to get it from the turma
  if (!targetUnit && req.body.id_turma) {
    try {
      const result = await db.query('SELECT id_unidade FROM turma WHERE id_turma=$1', [req.body.id_turma]);
      targetUnit = result.rows[0]?.id_unidade;
      console.log('   Target unit (de turma):', targetUnit);
    } catch (err) {
      console.error('❌ RBAC: Erro ao buscar unidade da turma:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  // If we're editing a colaborador (PUT /colaboradores/:id) and no targetUnit yet, get it from the colaborador
  if (!targetUnit && req.params.id && req.method === 'PUT' && 
      (req.originalUrl.includes('/colaboradores/') || req.baseUrl.includes('/colaboradores'))) {
    try {
      const result = await db.query('SELECT id_unidade FROM colaborador WHERE id_colaborador=$1', [req.params.id]);
      targetUnit = result.rows[0]?.id_unidade;
      console.log('   Target unit (do colaborador):', targetUnit);
    } catch (err) {
      console.error('❌ RBAC: Erro ao buscar unidade do colaborador:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  if (!targetUnit) {
    console.log('❌ RBAC: Nenhuma unidade especificada (forbidden - no unit context)');
    return res.status(403).json({ error: 'forbidden - no unit context' });
  }
  
  if (user.role === 'coordenador' && Number(user.id_unidade) === Number(targetUnit)) {
    console.log('✅ RBAC: Coordenador acessando sua própria unidade - acesso permitido');
    return next();
  }
  
  console.log(`❌ RBAC: Acesso negado - coordenador tentando acessar unidade ${targetUnit} mas pertence à ${user.id_unidade}`);
  return res.status(403).json({ error: 'forbidden' });
}

module.exports = {
  requireAdmin,
  requireRecrutamento,
  requireAdminOrRecrutamentoReadOnly,
  requireUnitOrAdmin,
  requireSalu,
  requireFiscalProva,
  requireDemandas,
  // Exported for testing purposes
  _requireRoles: requireRoles,
};
