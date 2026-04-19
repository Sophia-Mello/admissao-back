function handlePgError(res, err, resourceName) {
  // Postgres foreign key violation
  if (err && err.code === '23503') {
    // Tentar identificar a tabela dependente na mensagem de erro
    let detailedMessage = `Não é possível remover este(a) ${resourceName} porque existem registros relacionados`;
    
    if (err.detail) {
      const detail = err.detail.toLowerCase();
      if (detail.includes('atribuicao')) {
        detailedMessage += ' (atribuições)';
      } else if (detail.includes('apontamento')) {
        detailedMessage += ' (apontamentos)';
      } else if (detail.includes('turma')) {
        detailedMessage += ' (turmas)';
      } else if (detail.includes('colaborador')) {
        detailedMessage += ' (colaboradores)';
      } else if (detail.includes('usuario')) {
        detailedMessage += ' (usuários)';
      }
    }
    
    detailedMessage += '. Remova ou transfira os registros dependentes primeiro.';
    
    return res.status(409).json({ error: detailedMessage });
  }
  
  // Postgres unique violation
  if (err && err.code === '23505') {
    return res.status(409).json({ error: `Este(a) ${resourceName} já existe ou há um conflito de dados únicos.` });
  }
  
  // default
  return res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

module.exports = { handlePgError };
