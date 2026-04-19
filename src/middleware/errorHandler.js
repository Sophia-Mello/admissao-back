// Middleware para padronizar tratamento de erros
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Erro de validação
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Dados inválidos',
      details: err.message
    });
  }

  // Erro de chave estrangeira
  if (err.code === '23503') {
    return res.status(409).json({
      error: 'Não é possível realizar esta operação',
      details: 'Existem registros vinculados que impedem esta ação'
    });
  }

  // Erro de chave duplicada
  if (err.code === '23505') {
    return res.status(409).json({
      error: 'Registro duplicado',
      details: 'Já existe um registro com estes dados'
    });
  }

  // Erro de trigger customizado (P0001) - DUPLICATE_TEMPLATE_APPLICATION
  if (err.code === 'P0001' && err.message.includes('DUPLICATE_TEMPLATE_APPLICATION')) {
    return res.status(409).json({
      error: 'Você já possui um agendamento de prova para esta vaga',
      code: 'DUPLICATE_TEMPLATE_APPLICATION',
      details: 'Candidatos só podem realizar uma prova por template, mesmo se inscritos em múltiplas vagas relacionadas.'
    });
  }

  // Erro de conexão com banco
  if (err.code === 'ECONNREFUSED') {
    return res.status(503).json({
      error: 'Serviço indisponível',
      details: 'Erro de conexão com o banco de dados'
    });
  }

  // Erro de sintaxe SQL
  if (err.code === '42601') {
    return res.status(500).json({
      error: 'Erro interno do servidor',
      details: 'Erro na consulta ao banco de dados'
    });
  }

  // Erro de permissão
  if (err.code === '42501') {
    return res.status(403).json({
      error: 'Acesso negado',
      details: 'Você não tem permissão para realizar esta ação'
    });
  }

  // Erro padrão
  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
};

module.exports = errorHandler;
