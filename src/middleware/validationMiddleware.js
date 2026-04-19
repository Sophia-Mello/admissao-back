const { validationResult } = require('express-validator');

// Middleware para padronizar validação
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(error => ({
      field: error.path,
      message: error.msg,
      value: error.value
    }));
    
    return res.status(400).json({
      error: 'Dados inválidos',
      details: formattedErrors
    });
  }
  
  next();
};

// Middleware para validar ID numérico
const validateId = (req, res, next) => {
  const id = req.params.id;
  
  if (!id || isNaN(parseInt(id))) {
    return res.status(400).json({
      error: 'ID inválido',
      details: 'O ID deve ser um número válido'
    });
  }
  
  req.params.id = parseInt(id);
  next();
};

// Middleware para validar paginação
const validatePagination = (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  
  if (page < 1) {
    return res.status(400).json({
      error: 'Página inválida',
      details: 'A página deve ser maior que 0'
    });
  }
  
  if (limit < 1 || limit > 100) {
    return res.status(400).json({
      error: 'Limite inválido',
      details: 'O limite deve estar entre 1 e 100'
    });
  }
  
  req.pagination = { page, limit, offset: (page - 1) * limit };
  next();
};

module.exports = {
  validateRequest,
  validateId,
  validatePagination
};
