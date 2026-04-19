#!/usr/bin/env node
/**
 * Regenera as views em rs_admissao_* que referenciam tabelas do rh_sistema_prod
 *
 * IMPORTANTE: Tanto homolog quanto prod usam rh_sistema_prod como fonte!
 * Isso garante que dados mestres (subregional, unidade, regional, usuario)
 * sejam consistentes entre os ambientes.
 *
 * As views usam SELECT * para facilitar manutenção, mas o PostgreSQL expande
 * as colunas no momento da criação. Quando novas colunas são adicionadas às
 * tabelas de origem, este script deve ser executado para atualizar as views.
 *
 * Uso:
 *   node scripts/regenerate-views.js              # usa DB_SCHEMA do .env
 *   node scripts/regenerate-views.js --prod       # força rs_admissao_prod
 *   node scripts/regenerate-views.js --homolog    # força rs_admissao_homolog
 */

require('dotenv').config();
const { Pool } = require('pg');

const args = process.argv.slice(2);
let targetSchema = process.env.DB_SCHEMA || 'rs_admissao_homolog';

// ALWAYS use rh_sistema_prod as source - master data (subregional, unidade, etc.)
// should be consistent across environments
let sourceSchema = 'rh_sistema_prod';

if (args.includes('--prod')) {
  targetSchema = 'rs_admissao_prod';
} else if (args.includes('--homolog')) {
  targetSchema = 'rs_admissao_homolog';
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const views = [
  {
    name: 'api_key',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.api_key;
      CREATE VIEW ${target}.api_key AS
      SELECT * FROM ${source}.api_key;
    `
  },
  {
    name: 'regional',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.regional;
      CREATE VIEW ${target}.regional AS
      SELECT DISTINCT r.*
      FROM ${source}.regional r
      WHERE EXISTS (
        SELECT 1 FROM ${source}.unidade u
        WHERE u.id_regional = r.id_regional AND u.id_empresa = 1
      );
    `
  },
  {
    name: 'subregional',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.subregional;
      CREATE VIEW ${target}.subregional AS
      SELECT DISTINCT s.*
      FROM ${source}.subregional s
      WHERE EXISTS (
        SELECT 1 FROM ${source}.unidade u
        WHERE u.id_subregional = s.id_subregional AND u.id_empresa = 1
      );
    `
  },
  {
    name: 'unidade',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.unidade;
      CREATE VIEW ${target}.unidade AS
      SELECT * FROM ${source}.unidade WHERE id_empresa = 1;
    `
  },
  {
    name: 'usuario',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.usuario;
      CREATE VIEW ${target}.usuario AS
      SELECT * FROM ${source}.usuario WHERE role IN ('recrutamento', 'salu', 'fiscal_prova');
    `
  },
  {
    name: 'funcao',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.funcao;
      CREATE VIEW ${target}.funcao AS
      SELECT id_funcao, nome_funcao
      FROM ${source}.funcao
      WHERE id_funcao = 67;
      COMMENT ON VIEW ${target}.funcao IS 'View de funções elegíveis para contratação automática (sempre aponta para prod).';
    `
  },
  {
    name: 'materia',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.materia;
      CREATE VIEW ${target}.materia AS
      SELECT id_materia, cod_materia, nome_materia
      FROM ${source}.materia;
      COMMENT ON VIEW ${target}.materia IS 'View de leitura da tabela materia do RH Sistema (sempre aponta para prod).';
    `
  },
  {
    name: 'colaborador',
    sql: (target, source) => `
      DROP VIEW IF EXISTS ${target}.colaborador;
      CREATE VIEW ${target}.colaborador AS
      SELECT
        c.id_colaborador,
        c.nome,
        c.cpf,
        c.email,
        c.celular,
        c.id_tipo_vinculo,
        c.id_unidade,
        u.id_empresa,
        u.nome_unidade
      FROM ${source}.colaborador c
      LEFT JOIN ${source}.unidade u ON u.id_unidade = c.id_unidade
      WHERE u.id_empresa = 1
        AND c.id_tipo_vinculo IN (50, 51, 53);
      COMMENT ON VIEW ${target}.colaborador IS 'View de colaboradores em processo de admissão (sempre aponta para prod). Filtros: id_empresa=1, id_tipo_vinculo IN (50=APROVADO, 51=LIBERADO, 53=EM_ADMISSAO).';
    `
  }
];

async function regenerateViews() {
  console.log(`\nRegenerando views em ${targetSchema} (fonte: ${sourceSchema})\n`);

  const client = await pool.connect();

  try {
    for (const view of views) {
      const sql = view.sql(targetSchema, sourceSchema);
      await client.query(sql);
      console.log(`  ✓ ${view.name}`);
    }

    console.log('\n✅ Todas as views regeneradas com sucesso!\n');
  } catch (err) {
    console.error(`\n❌ Erro ao regenerar views: ${err.message}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

regenerateViews();
