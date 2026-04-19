// backend/db.js
const { Pool, types } = require('pg');

// Configurar pg para retornar datas como strings simples (sem timezone)
// TYPE_ID 1082 = DATE
types.setTypeParser(1082, (val) => val);

// Build pool config explicitly and coerce types to avoid errors like
// "client password must be a string" when environment variables are set in an unexpected way.
function buildPoolConfig() {
  // Start with connection string if provided
  const hasDatabaseUrl = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim().length > 0;
  const cfg = {};

  if (hasDatabaseUrl) {
    cfg.connectionString = String(process.env.DATABASE_URL).trim();
  } else {
    if (process.env.PGHOST) cfg.host = String(process.env.PGHOST).trim();
    if (process.env.PGUSER) cfg.user = String(process.env.PGUSER).trim();
    if (process.env.PGPASSWORD !== undefined && process.env.PGPASSWORD !== null) cfg.password = String(process.env.PGPASSWORD).trim();
    if (process.env.PGDATABASE) cfg.database = String(process.env.PGDATABASE).trim();
    if (process.env.PGPORT) {
      const p = parseInt(process.env.PGPORT, 10);
      if (!Number.isNaN(p)) cfg.port = p;
    }
  }

  // SSL handling
  // DB_SSL: '1'|'true' enables SSL; DB_SSL_REJECT_UNAUTHORIZED: '0'|'false' will disable verification (dev only)
  const envDbSsl = process.env.DB_SSL || process.env.PGSSLMODE; // allow PGSSLMODE detection
  const sslEnabled = typeof envDbSsl === 'string' && (envDbSsl === '1' || /^(true|require|verify-full|verify-ca)$/i.test(envDbSsl));
  if (sslEnabled) {
    const rejectUnauthorized = !(process.env.DB_SSL_REJECT_UNAUTHORIZED === '0' || /^(false|0)$/i.test(String(process.env.DB_SSL_REJECT_UNAUTHORIZED || '')));
    const ssl = { rejectUnauthorized };
    if (process.env.DB_SSL_CA) {
      // allow passing PEM content directly in env var
      ssl.ca = String(process.env.DB_SSL_CA);
    }
    cfg.ssl = ssl;
  }

  return cfg;
}

const cfg = buildPoolConfig();

// If cfg is empty, avoid creating a Pool that will attempt a connection
// and surface low-level errors; instead export a clear failing query helper.
const isCfgEmpty = Object.keys(cfg).length === 0;

if (isCfgEmpty) {
  module.exports = {
    query: () => Promise.reject(new Error('No DB configuration found. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE')),
    pool: null,
  };
} else {
  // show helpful debug info about how we are connecting (don't log passwords)
  try {
    const reported = Object.assign({}, cfg);
    if (reported.password) reported.password = '*****';
    // eslint-disable-next-line no-console
    console.info('[db] creating pg.Pool with config:', reported.connectionString ? { connectionString: reported.connectionString, ssl: reported.ssl ? { ...reported.ssl, ca: reported.ssl.ca ? '***CA***' : undefined } : undefined } : { host: reported.host, port: reported.port, user: reported.user, database: reported.database, ssl: reported.ssl ? { rejectUnauthorized: reported.ssl.rejectUnauthorized } : undefined });
  } catch (err) {
    // ignore logging errors
  }

  const pool = new Pool(cfg);
  
  // Configure search_path based on DB_SCHEMA environment variable
  // Default to homolog schema for safety - production MUST set DB_SCHEMA=rs_admissao_prod explicitly
  const dbSchema = process.env.DB_SCHEMA || 'rs_admissao_homolog';
  
  // Set search_path and timezone on pool connection
  pool.on('connect', (client) => {
    // Configurar search_path
    client.query(`SET search_path TO ${dbSchema}, public`, (err) => {
      if (err) {
        console.error(`[db] Failed to set search_path to ${dbSchema}:`, err.message);
      } else {
        console.info(`[db] search_path set to: ${dbSchema}, public`);
      }
    });
    
    // Configurar timezone para horário de Brasília (GMT-3)
    client.query(`SET timezone = 'America/Sao_Paulo'`, (err) => {
      if (err) {
        console.error(`[db] Failed to set timezone to America/Sao_Paulo:`, err.message);
      } else {
        console.info(`[db] timezone set to: America/Sao_Paulo (GMT-3)`);
      }
    });
  });

  module.exports = {
    query: (text, params) => pool.query(text, params),
    // Provide a client getter for transactional operations
    getClient: async () => {
      const client = await pool.connect();
      // Ensure search_path and timezone are set for this client too
      await client.query(`SET search_path TO ${dbSchema}, public`);
      await client.query(`SET timezone = 'America/Sao_Paulo'`);
      return client;
    },
    pool,
    // Export current schema for reference
    currentSchema: dbSchema,
    schema: dbSchema, // Alias for backward compatibility
  };
}
