// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');

// ═══════════════════════════════════════════════════
// ROUTES - REFACTORED (2024-12-01)
// ═══════════════════════════════════════════════════
const authRoutes = require('./src/routes/auth');
const unidadeRoutes = require('./src/routes/unidade');

// New refactored routes
const bookingRoutes = require('./src/routes/booking');
const availabilityRoutes = require('./src/routes/availability');
const scheduleRoutes = require('./src/routes/schedule');
const scheduleBlockRoutes = require('./src/routes/schedule-block');
const jobRoutes = require('./src/routes/job');
const gupyRoutes = require('./src/routes/gupy');
const subregionalRoutes = require('./src/routes/subregional');
const exameOcupacionalRoutes = require('./src/routes/exame-ocupacional');
const eventoRoutes = require('./src/routes/evento');
const candidatoRoutes = require('./src/routes/candidato');
const applicationRoutes = require('./src/routes/application');
const demandasRoutes = require('./src/routes/demandas');
const eventTypesRoutes = require('./src/routes/admin/eventTypes');
const actionsRoutes = require('./src/routes/admin/actions');

// Webhooks
const gupyAdmissionWebhook = require('./src/routes/webhooks/gupyAdmission');
const gupyAppCreated = require('./src/routes/webhooks/gupyApplicationCreated');
const gupyAppMoved = require('./src/routes/webhooks/gupyApplicationMoved');

// Audit middleware
const { auditMiddleware } = require('./src/middleware/auditMiddleware');

// Services (polling)
const contratacaoPollingService = require('./src/services/contratacaoPollingService');

// Legacy routes - COMMENTED OUT during refactoring
// Uncomment once legacy files are deleted or updated
// const publicBookingsRoutes = require('./src/routes/public-bookings');
// const adminBookingsRoutes = require('./src/routes/admin-bookings');
// const bookingsRoutes = require('./src/routes/bookings');
// const scheduleConfigRoutes = require('./src/routes/schedule-config');
// const regionalRoutes = require('./src/routes/regional');
// const regionalJobsRoutes = require('./src/routes/regional-jobs');
// const gupyIntegrationRoutes = require('./src/routes/gupy-integration');
// const debugRegionalJobsRoutes = require('./src/routes/debug-regional-jobs');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const { requireAuth, requireRole } = require('./src/middleware/authMiddleware');
const {
  generalLimiter,
  authLimiter,
  helmetConfig,
  sanitizeInput,
  securityHeaders,
  validateJWTSecret
} = require('./src/middleware/security');

// load openapi spec
let openapiSpec = {};
try {
  openapiSpec = YAML.load('./openapi.yaml');
} catch (e) {
  console.warn('openapi.yaml not found or invalid, /api-docs will show error');
}

// Validate JWT secret before starting
validateJWTSecret();

const app = express();

// Trust proxy (nginx) for X-Forwarded-For headers
// Required for express-rate-limit to work correctly behind reverse proxy
app.set('trust proxy', 1);

// Security middleware (order matters!)
app.use(helmetConfig);
app.use(securityHeaders);
app.use(sanitizeInput);

// CORS configuration (MUST be before rate limiting so 429 responses include CORS headers)
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      // Get allowed origins from environment
      const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
      const allowedOrigins = [
        frontendOrigin,
        frontendOrigin.replace('://', '://www.'), // Also allow www variant
        'http://localhost:3000', // Always allow localhost for development
        'https://recrutamento-dev.rhsistema.com.br', // Dev frontend
        'https://www.recrutamento-dev.rhsistema.com.br', // Dev frontend (www)
        'https://recrutamento-homolog.rhsistema.com.br', // Homolog frontend
        'https://www.recrutamento-homolog.rhsistema.com.br', // Homolog frontend (www)
        'https://recrutamento.rhsistema.com.br', // Production frontend
        'https://www.recrutamento.rhsistema.com.br' // Production frontend (www)
      ];

      // Normalize origin and allowed origins by removing trailing slash
      const normalizedOrigin = origin.replace(/\/$/, '');
      const normalizedAllowed = allowedOrigins.map(o => o.replace(/\/$/, ''));

      if (normalizedAllowed.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'ngrok-skip-browser-warning']
  })
);

// Rate limiting (100 requests per 15 minutes per IP)
// TEMPORARILY DISABLED - monitoring for performance issues
// TODO: Re-enable after confirming system stability
// app.use(generalLimiter);

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Audit middleware (after body parsing, before routes)
app.use(auditMiddleware);

app.get('/health', async (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';

  try {
    const result = await db.query('SELECT 1 AS ok');

    if (result && result.rows) {
      // In production, return minimal response (no info disclosure)
      if (isProduction) {
        return res.json({ status: 'ok' });
      }

      // In dev/homolog, include diagnostic info
      const schemaResult = await db.query('SELECT current_schema()');
      return res.json({
        status: 'ok',
        diag: {
          env_database_url: !!process.env.DATABASE_URL,
          env_pg_vars: !!(process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE),
          schema: db.currentSchema,
          node_env: process.env.NODE_ENV || 'development',
        },
        activeSchema: schemaResult.rows[0].current_schema
      });
    }

    return res.status(500).json({ status: 'db-error' });
  } catch (err) {
    console.error('health check error', err && err.message ? err.message : err);
    // Don't expose error details in production
    if (isProduction) {
      return res.status(500).json({ status: 'error' });
    }
    return res.status(500).json({ status: 'error', error: err && err.message ? err.message : String(err) });
  }
});

// ═══════════════════════════════════════════════════
// ROUTE REGISTRATION - R&S Admissão Module (REFACTORED)
// ═══════════════════════════════════════════════════

// Auth routes (stricter rate limit: 20 requests per 5 minutes per IP)
app.use('/api/v1/auth', authLimiter, authRoutes);

// Unidade routes (GET only - read from cross-schema FK)
app.use('/api/v1/unidade', unidadeRoutes);
app.use('/api/v1/unidades', unidadeRoutes);

// ═══════════════════════════════════════════════════
// NEW REFACTORED ROUTES (2024-12-01)
// ═══════════════════════════════════════════════════

// Booking (hybrid auth - public + private)
app.use('/api/v1/booking', bookingRoutes);

// Availability (public slots query)
app.use('/api/v1/availability', availabilityRoutes);

// Schedule config (protected)
app.use('/api/v1/schedule', scheduleRoutes);
app.use('/api/v1/schedule-block', scheduleBlockRoutes);

// Jobs (unified - CRUD + Gupy integration)
app.use('/api/v1/job', jobRoutes);
app.use('/api/v1/jobs', jobRoutes);

// Gupy integration (protected)
app.use('/api/v1/gupy', gupyRoutes);
app.use('/api/v1/admin/gupy', gupyRoutes);

// Subregional routes (list subregionais and unidades)
app.use('/api/v1/admin/subregional', subregionalRoutes);

// Event Types (dynamic event type management)
app.use('/api/v1/admin/event-types', eventTypesRoutes);

// Actions (action history and undo operations)
app.use('/api/v1/admin/actions', actionsRoutes);

// Exame Ocupacional (Kanban de candidatos para exames ocupacionais)
app.use('/api/v1/exame-ocupacional', exameOcupacionalRoutes);

// Evento (Sistema de agendamento genérico - prova teórica, etc.)
app.use('/api/v1/evento', eventoRoutes);

// Candidato (Public hub - consolidated lookup for all scheduling systems)
app.use('/api/v1/candidato', candidatoRoutes);

// Application (Gestao de Candidaturas - CRUD + Gupy integration)
app.use('/api/v1/applications', applicationRoutes);

// Gestao de Demandas (read-only HR demand data)
app.use('/api/v1/demandas', demandasRoutes);

// ═══════════════════════════════════════════════════
// WEBHOOKS (External integrations - NO AUTH)
// ═══════════════════════════════════════════════════
// Gupy Admissão webhook (pre-employee.moved events)
app.use('/api/v1/webhooks/gupy/admission', gupyAdmissionWebhook);
// Gupy Application webhooks (audit/KPI events)
app.use('/api/v1/webhooks/gupy/application-created', gupyAppCreated);
app.use('/api/v1/webhooks/gupy/application-moved', gupyAppMoved);

// ═══════════════════════════════════════════════════
// LEGACY ROUTES - DISABLED DURING REFACTORING
// ═══════════════════════════════════════════════════
// Legacy routes are commented out. Delete old files and remove this section.
// app.use('/api/v1/bookings', bookingsRoutes);
// app.use('/api/v1/public/bookings', bookingsRoutes);
// app.use('/api/v1/admin/bookings', bookingsRoutes);
// app.use('/api/v1/admin/schedule-config', scheduleConfigRoutes);
// app.use('/api/v1/admin/schedule-blocks', scheduleBlockRoutes);
// app.use('/api/v1/admin/regional', regionalRoutes);
// app.use('/api/v1/admin/regional-jobs', regionalJobsRoutes);
// app.use('/api/v1/admin/gupy', gupyIntegrationRoutes);

// Migration route REMOVED - use npm run migrate:* commands instead
// See: npm run migrate:status, migrate:up:homolog, migrate:up:prod

// API docs (protected)
app.use('/api-docs', requireAuth, requireRole('admin'), swaggerUi.serve, swaggerUi.setup(openapiSpec, { explorer: true }));

const PORT = process.env.PORT || 4001;
if (require.main === module) {
  // ═══════════════════════════════════════════════════
  // VALIDAÇÕES DE CONFIGURAÇÃO
  // ═══════════════════════════════════════════════════

  const NODE_ENV = process.env.NODE_ENV || 'development';
  const DB_SCHEMA = process.env.DB_SCHEMA || 'rs_admissao_homolog';

  console.log('\n═══════════════════════════════════════════════════');
  console.log('🚀 INICIANDO BACKEND - R&S ADMISSÃO');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📌 NODE_ENV: ${NODE_ENV}`);
  console.log(`📌 DB_SCHEMA: ${DB_SCHEMA}`);
  console.log(`📌 PORT: ${PORT}`);
  console.log('═══════════════════════════════════════════════════\n');

  // 1. VALIDAÇÃO CRÍTICA: JWT_SECRET em produção
  if (NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('❌ FATAL: NODE_ENV=production mas JWT_SECRET não está configurado.');
    console.error('   Configure JWT_SECRET no .env antes de rodar em produção.');
    process.exit(1);
  }

  // 2. VALIDAÇÃO CRÍTICA: Schema correto para R&S Admissão
  if (NODE_ENV === 'production' && DB_SCHEMA !== 'rs_admissao_prod') {
    console.error('❌ FATAL: NODE_ENV=production mas DB_SCHEMA não é rs_admissao_prod');
    console.error('   Esta é uma configuração PERIGOSA que pode causar perda de dados!');
    console.error('   Para produção, use: DB_SCHEMA=rs_admissao_prod');
    console.error('   Para homologação, use: NODE_ENV=homolog DB_SCHEMA=rs_admissao_homolog');
    process.exit(1);
  }

  // 3. VALIDAÇÃO CRÍTICA: Schema existe e é válido para R&S Admissão
  const validSchemas = ['rs_admissao_prod', 'rs_admissao_homolog'];
  if (!validSchemas.includes(DB_SCHEMA)) {
    console.error(`❌ FATAL: DB_SCHEMA='${DB_SCHEMA}' não é válido para R&S Admissão.`);
    console.error(`   Schemas válidos: ${validSchemas.join(', ')}`);
    console.error('   Certifique-se de usar o schema correto para este módulo.\n');
    process.exit(1);
  }

  // 4. AVISO: Configurações suspeitas (não bloqueantes)
  if (NODE_ENV === 'homolog' && DB_SCHEMA === 'rs_admissao_prod') {
    console.warn('⚠️  AVISO: NODE_ENV=homolog mas DB_SCHEMA=rs_admissao_prod');
    console.warn('   Você está usando dados de PRODUÇÃO em ambiente de HOMOLOGAÇÃO!');
    console.warn('   Isso pode ser intencional, mas verifique se está correto.\n');
  }

  if (NODE_ENV === 'development' && DB_SCHEMA === 'rs_admissao_prod') {
    console.warn('⚠️  AVISO: NODE_ENV=development mas DB_SCHEMA=rs_admissao_prod');
    console.warn('   Você está usando dados de PRODUÇÃO em DESENVOLVIMENTO!');
    console.warn('   Recomenda-se usar DB_SCHEMA=rs_admissao_homolog para desenvolvimento.\n');
  }

  // 5. INFO: Configuração recomendada para cada ambiente
  console.log('ℹ️  Configurações recomendadas (R&S Admissão):');
  console.log('   🟢 PRODUÇÃO:        NODE_ENV=production     DB_SCHEMA=rs_admissao_prod');
  console.log('   🟡 HOMOLOGAÇÃO:     NODE_ENV=homolog        DB_SCHEMA=rs_admissao_homolog');
  console.log('   🔵 DESENVOLVIMENTO: NODE_ENV=development    DB_SCHEMA=rs_admissao_homolog\n');

  // Iniciar servidor
  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log(`✅ Backend R&S Admissão rodando na porta ${PORT}`);
    console.log(`✅ Ambiente: ${NODE_ENV}`);
    console.log(`✅ Schema: ${DB_SCHEMA}`);
    console.log('═══════════════════════════════════════════════════\n');

    // Iniciar polling de contratação automática (apenas se feature habilitada)
    if (process.env.ENABLE_CONTRATACAO_POLLING === 'true') {
      contratacaoPollingService.startPolling();
      console.log('✅ Polling de contratação automática iniciado');
    }
  });
}

module.exports = app;
