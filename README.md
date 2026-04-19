# R&S Admissao Backend

API REST para o modulo de Recrutamento e Selecao (R&S) e Admissoes do RHSistema. Gerencia vagas, candidaturas, agendamento de Aula Teste, provas online, exames ocupacionais, fluxo de contratacao e integracao com a plataforma Gupy.

**Stack:** Express.js 4.18 | Node.js 20 | PostgreSQL 15+ | JWT + bcrypt | RBAC (6 roles) | Gupy API | Google Calendar API

---

## Sumario

1. [Visao Geral](#1-visao-geral)
2. [Arquitetura](#2-arquitetura)
3. [Pre-requisitos](#3-pre-requisitos)
4. [Setup Local (Desenvolvimento)](#4-setup-local-desenvolvimento)
5. [Testes](#5-testes)
6. [Estrutura do Projeto](#6-estrutura-do-projeto)
7. [Autenticacao e Autorizacao](#7-autenticacao-e-autorizacao)
8. [Referencia de API](#8-referencia-de-api)
9. [Middlewares](#9-middlewares)
10. [Servicos e Integracao](#10-servicos-e-integracao)
11. [Banco de Dados](#11-banco-de-dados)
12. [Webhooks](#12-webhooks)
13. [Deploy com Docker](#13-deploy-com-docker)
14. [Deploy em Producao (Lightsail)](#14-deploy-em-producao-lightsail)
15. [CI/CD com GitHub Actions](#15-cicd-com-github-actions)
16. [Seguranca](#16-seguranca)
17. [Variaveis de Ambiente](#17-variaveis-de-ambiente)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Visao Geral

O R&S Admissao e um modulo independente do ecossistema RHSistema, focado no processo de recrutamento, selecao e admissao de colaboradores para instituicoes educacionais. Principais funcionalidades:

- **Gestao de vagas** — criacao, publicacao, encerramento e sincronizacao com a plataforma Gupy
- **Agendamento de Aula Teste** — candidatos agendam por autoservico ou via recrutador, com slots configuraveis por unidade
- **Provas online** — agendamento multi-sala, monitoramento em tempo real (fiscal de prova), registro de ocorrencias
- **Exames ocupacionais** — pipeline Kanban para gestao de exames admissionais (SALU)
- **Contratacao automatica** — fluxo automatizado: aprovacao → criacao de colaborador no RH Sistema → admissao Gupy
- **Demandas de ensino** — visualizacao de demandas abertas por disciplina/unidade, mobilidade interna de CLTs
- **Google Calendar** — criacao automatica de eventos com link Meet para Aula Teste
- **Webhooks Gupy** — recepcao de eventos de admissao, criacao e movimentacao de candidaturas
- **Multi-schema** — schemas separados para homolog (`rs_admissao_homolog`) e producao (`rs_admissao_prod`)
- **Cross-database** — acesso read-only ao schema `rh_sistema_prod` para dados de unidades, colaboradores e demandas

---

## 2. Arquitetura

```
                    ┌──────────────────┐
                    │ Frontend R&S     │
                    │ (recrutamento.   │
                    │  rhsistema.com)  │
                    └────────┬─────────┘
                             │ HTTPS (JWT Bearer)
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Express.js Backend (:4001)                       │
│                                                                         │
│  Security → Auth → RBAC → Audit → Route Handlers → Services → DB      │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                        Route Handlers                            │   │
│  │  booking | job | schedule | availability | applications          │   │
│  │  evento | exame-ocupacional | demandas | candidato | admin       │   │
│  │  gupy | webhooks | auth | unidade                                │   │
│  └────────────────────────────┬─────────────────────────────────────┘   │
│                               │                                         │
│         ┌─────────────────────┼─────────────────────┐                   │
│         ▼                     ▼                     ▼                   │
│  ┌─────────────┐   ┌──────────────────┐   ┌──────────────┐             │
│  │ Services    │   │ Libs             │   │ Middleware    │             │
│  │ gupyService │   │ slot/booking     │   │ auth/rbac    │             │
│  │ calendar    │   │ job/jobHelpers   │   │ security     │             │
│  │ contratacao │   │ lock/batch       │   │ audit/cache  │             │
│  │ rhSistema   │   │ cvSync/cvPdf    │   │ validation   │             │
│  │ eventLog    │   │ salarioCalc      │   │ errorHandler │             │
│  └──────┬──────┘   └────────┬─────────┘   └──────────────┘             │
│         │                   │                                           │
└─────────┼───────────────────┼───────────────────────────────────────────┘
          │                   │
          ▼                   ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  PostgreSQL 15+  │  │  Gupy API    │  │ Google       │  │  RH Sistema  │
│  rs_admissao_*   │  │  (vagas,     │  │ Calendar API │  │  (cross-     │
│  + rh_sistema_*  │  │  candidatos) │  │ (eventos,    │  │   schema     │
│  (cross-schema)  │  │              │  │  Meet links) │  │   queries)   │
└──────────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

### Fluxo principal: Aula Teste

1. Recrutador cria vaga no sistema (sincronizada com Gupy)
2. Candidato acessa portal publico e busca suas candidaturas (`POST /booking/lookup`)
3. Sistema consulta Gupy para verificar elegibilidade (etapa "Aula Teste")
4. Candidato visualiza slots disponiveis (`GET /availability`)
5. Candidato agenda Aula Teste (`POST /booking`)
   - Advisory lock previne agendamento duplo
   - Evento criado no Google Calendar (unidade + candidato)
   - URL da rubrica (Google Forms) gerada automaticamente
6. Dia da aula: recrutador marca presenca e avaliacao (`PATCH /booking/:id`)
7. Se aprovado + interesse → fluxo de contratacao automatico inicia
   - Calculo de salario, criacao de colaborador no RH Sistema
   - Pre-employee avanca no pipeline de admissao

---

## 3. Pre-requisitos

| Ferramenta | Versao | Observacao |
|------------|--------|------------|
| Node.js | 20.x (LTS) | Obrigatorio |
| npm | 10+ | Vem com Node.js 20 |
| Git | 2.x+ | Controle de versao |
| PostgreSQL | 15+ | Pode conectar ao banco remoto |

---

## 4. Setup Local (Desenvolvimento)

### 4.1. Clonar e instalar

```bash
git clone https://github.com/techTOMAPG/v0-backend-rs-admissao.git
cd v0-backend-rs-admissao
npm install
```

### 4.2. Configurar variaveis de ambiente

```bash
cp .env.example .env
```

Conteudo minimo para desenvolvimento local:

```env
# Banco de dados
DATABASE_URL=postgresql://user:pass@localhost:5432/postgres
DB_SCHEMA=rs_admissao_homolog
DB_SSL=false

# Servidor
NODE_ENV=development
PORT=4001

# Seguranca
JWT_SECRET=qualquer-chave-para-dev-local-min-32-chars
FRONTEND_ORIGIN=http://localhost:3000

# Admin seed
ADMIN_EMAIL=admin@local.test
ADMIN_PASSWORD=SenhaForte123!

# Gupy (obrigatorio para integracao)
GUPY_API_KEY=sua-api-key
GUPY_API_URL=https://api.gupy.io
```

### 4.3. Banco de dados

**Opcao A — Conectar ao banco remoto (RDS):**
```env
DATABASE_URL=postgresql://user:pass@host.rds.amazonaws.com:5432/postgres
DB_SCHEMA=rs_admissao_homolog
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
```

**Opcao B — PostgreSQL local:**
```bash
psql -c "CREATE SCHEMA rs_admissao_homolog;" -d postgres
npm run db:init
npm run migrate:up:homolog
npm run seed:admin
```

### 4.4. Verificar conexao

```bash
npm run db:test
```

### 4.5. Iniciar o servidor

```bash
npm run dev              # Usa DB_SCHEMA do .env (com auto-reload)
npm run dev:homolog      # Forca schema rs_admissao_homolog
npm run dev:prod         # Forca schema rs_admissao_prod
```

O servidor inicia em `http://localhost:4001`.

### 4.6. Validar

```bash
curl http://localhost:4001/health
# {"status":"ok","schema":"rs_admissao_homolog",...}
```

---

## 5. Testes

### 5.1. Comandos

```bash
npm test                 # Todos os testes
npm run test:e2e         # Testes end-to-end
```

### 5.2. Configuracao

- **Framework:** Jest 30.1 com supertest e nock
- **Coverage:** Threshold minimo de 50% (linhas, statements, branches, funcoes)
- **Timeout:** 30 segundos
- **Setup:** `tests/setup.js`

### 5.3. Categorias de teste

| Categoria | Diretorio | O que testa |
|-----------|-----------|-------------|
| Unit | `tests/unit/` | Libs, helpers, constantes |
| Integration | `tests/integration/` | Fluxos de booking, job, CV |
| Middleware | `tests/middleware/` | Auth, RBAC, validacao, audit, cache |
| API | `tests/api/` | Endpoints gerais |

---

## 6. Estrutura do Projeto

```
backend/
├── server.js                 # Entry point — registro de rotas, middlewares, CORS
├── db.js                     # Pool PostgreSQL, schema, SSL, timezone
├── package.json              # Dependencias e scripts
├── .env.example              # Template de variaveis
├── Dockerfile                # Imagem Docker (Node 20 slim)
├── jest.config.js            # Configuracao Jest
│
├── migrations/               # 58 migracoes SQL (node-pg-migrate)
│
├── src/
│   ├── auth.js               # Geracao/validacao JWT (HS256, 8h)
│   │
│   ├── routes/               # Handlers de rotas
│   │   ├── auth.js           # Login, validacao
│   │   ├── booking.js        # Agendamento Aula Teste (CRUD + lookup)
│   │   ├── availability.js   # Consulta de slots disponiveis
│   │   ├── schedule.js       # Configuracao de horarios
│   │   ├── scheduleBlock.js  # Bloqueios de horario
│   │   ├── job.js            # Gestao de vagas (CRUD + batch)
│   │   ├── applications.js   # Candidaturas (listagem, sync, batch actions)
│   │   ├── gupy.js           # Proxy para API Gupy
│   │   ├── evento.js         # Eventos genericos (provas, exames)
│   │   ├── eventoApplications.js # Inscricoes em eventos
│   │   ├── eventoMonitor.js  # Monitoramento de presenca
│   │   ├── eventoDashboard.js # Dashboard de eventos
│   │   ├── eventoReports.js  # Ocorrencias/relatorios
│   │   ├── exameOcupacional.js # Pipeline de exames (Kanban)
│   │   ├── candidato.js      # Upsert e lookup de candidatos
│   │   ├── demandas.js       # Demandas de ensino
│   │   ├── unidade.js        # Unidades escolares
│   │   ├── adminEventTypes.js # CRUD tipos de evento
│   │   ├── adminActions.js   # Historico de acoes + undo
│   │   ├── adminSubregional.js # Subregionais com unidades
│   │   └── webhooks.js       # Webhooks Gupy (admission, application)
│   │
│   ├── middleware/
│   │   ├── authMiddleware.js      # JWT + API Key (requireAuth, requireRole)
│   │   ├── rbac.js                # RBAC (6 roles: admin, recrutamento, salu, etc.)
│   │   ├── security.js            # Helmet, sanitizacao, rate limiting
│   │   ├── auditMiddleware.js     # Log de requisicoes (method, path, user, timing)
│   │   ├── validateApplication.js # Validacao de candidatura (Gupy + no-show)
│   │   ├── cache.js               # Cache em memoria (NodeCache)
│   │   ├── errorHandler.js        # Tratamento global de erros PG
│   │   └── validationMiddleware.js # Setup express-validator
│   │
│   ├── services/
│   │   ├── gupyService.js              # API Gupy v2 (vagas, candidaturas, movimentacao)
│   │   ├── gupyAdmissionService.js     # Pipeline de admissao Gupy
│   │   ├── calendarService.js          # Google Calendar (criar/deletar eventos)
│   │   ├── driveService.js             # Google Drive (armazenamento de CVs)
│   │   ├── contratacaoService.js       # Fluxo automatizado de contratacao
│   │   ├── contratacaoPollingService.js # Polling para retry de contratacoes com erro
│   │   ├── rhSistemaService.js         # Queries cross-schema (demandas, colaboradores)
│   │   ├── eventLogService.js          # Audit trail (event_log)
│   │   ├── actionHistoryService.js     # Historico de acoes + undo
│   │   └── webhookCandidateService.js  # Sync de candidatos via webhook
│   │
│   ├── lib/
│   │   ├── booking.js             # Regras de negocio (validacao, conflitos)
│   │   ├── slot.js                # Geracao e filtragem de slots
│   │   ├── slotGenerator.js       # Algoritmo D-rule para criacao de slots
│   │   ├── job.js                 # Orquestracao CRUD de vagas (local + Gupy)
│   │   ├── jobHelpers.js          # Status, templates, batch operations
│   │   ├── lock.js                # Advisory lock PostgreSQL (anti-double-booking)
│   │   ├── batch.js               # Processamento em lote (chunking)
│   │   ├── batchAction.js         # Acoes em massa via Gupy
│   │   ├── applicationSync.js     # Sync de candidaturas da Gupy
│   │   ├── candidaturasValidas.js # Candidaturas validas por unidade
│   │   ├── cvSync.js              # Sync de CV do candidato (cache 24h)
│   │   ├── cvTransformer.js       # Parsing de CV em texto estruturado
│   │   ├── cvPdfGenerator.js      # Geracao de PDF de CV (PDFKit)
│   │   ├── googleCalendar.js      # Wrapper Google Calendar API v3
│   │   ├── rubrica.js             # URL builder para rubrica (Google Forms)
│   │   ├── gupyLimiter.js         # Rate limiter (Bottleneck)
│   │   ├── salarioCalculator.js   # Calculo de salario (hora-aula * CH * 4.33)
│   │   ├── date.js                # Utilitarios de data (timezone-aware)
│   │   ├── email.js               # Envio de email (Nodemailer)
│   │   ├── errorLogger.js         # Log estruturado de erros
│   │   ├── eventTypeResolver.js   # Resolve tipo de evento por codigo/template
│   │   ├── systemConfig.js        # Configuracao de sistema (key-value)
│   │   ├── pgErrors.js            # Traducao de erros PostgreSQL
│   │   ├── brazilianStates.js     # Codigos de estados
│   │   └── constants/gupy.js      # Constantes da API Gupy
│   │
│   └── errors/
│       └── AppError.js            # Classe de erro customizada
│
├── scripts/
│   ├── migrate.js             # Runner de migracoes (status, up, dry-run)
│   ├── init-db.js             # Inicializacao do banco
│   ├── seed-admin.js          # Criacao de usuario admin
│   ├── test-db-connection.js  # Teste de conexao
│   ├── setup-production.js    # Validacao pre-deploy
│   ├── setup-calendars.js     # Inicializacao Google Calendar
│   ├── regenerate-views.js    # Recriar views SQL
│   ├── map-schema-structure.js # Mapear schema
│   ├── compare-schemas.js     # Diff homolog vs prod
│   └── check-schema.js        # Validacao de schema
│
├── tests/
│   ├── setup.js               # Setup global dos testes
│   ├── unit/                  # Testes unitarios
│   ├── integration/           # Testes de integracao
│   ├── middleware/            # Testes de middleware
│   └── api/                   # Testes de API
│
└── .github/
    └── workflows/
        ├── deploy-develop.yml # Deploy: push em develop
        ├── deploy-main.yml    # Deploy: push em main
        └── run-migrations.yml # Execucao manual de migracoes
```

---

## 7. Autenticacao e Autorizacao

### 7.1. JWT

- **Algoritmo:** HS256
- **Expiracao:** 8 horas
- **Secret:** `JWT_SECRET` (minimo 32 chars em producao)
- **Payload:** `{ id_usuario, email, role, id_unidade, id_colaborador }`
- **Header:** `Authorization: Bearer <token>`

### 7.2. API Keys

- Hash bcrypt no banco, cache de 5 minutos
- Header: `X-API-Key: <chave>`
- Mesmo sistema de permissoes do JWT

### 7.3. Roles e permissoes

| Role | Escopo | Acesso |
|------|--------|--------|
| `admin` | Global | Acesso total |
| `recrutamento` | R&S | Vagas, candidaturas, agendamentos, eventos, integracao Gupy |
| `salu` | Saude | Exames ocupacionais apenas |
| `fiscal_prova` | Eventos | Monitoramento de presenca e ocorrencias |
| `coordenador` | Unidade | Dados da propria unidade |
| `demandas` | Demandas | Admin, recrutamento ou coordenador (scoped) |

### 7.4. Middlewares de autorizacao

| Middleware | Roles permitidos |
|-----------|-----------------|
| `requireAuth` | Qualquer usuario autenticado |
| `requireAdmin` | admin |
| `requireRecrutamento` | admin, recrutamento |
| `requireSalu` | admin, recrutamento, salu |
| `requireFiscalProva` | admin, recrutamento, fiscal_prova |
| `requireDemandas` | admin, recrutamento, coordenador (unit-scoped) |
| `requireUnitOrAdmin` | admin ou coordenador da unidade |

---

## 8. Referencia de API

Base URL: `/api/v1/`. Auth via `Authorization: Bearer <jwt>` ou `X-API-Key`.

### 8.1. Saude e Autenticacao

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/health` | Nao | Health check (conectividade BD, schema) |
| POST | `/auth/login` | Nao | Login (email + senha → JWT) |
| POST | `/auth/validate` | Bearer | Validar token |
| GET | `/auth/validate-application` | Nao | Verificar elegibilidade de candidatura |

### 8.2. Booking (Agendamento Aula Teste)

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| POST | `/booking/lookup` | Nao | Candidato busca suas candidaturas (CPF + email) |
| GET | `/booking` | Recrutamento | Listar agendamentos (filtros) |
| GET | `/booking/:id` | Recrutamento | Detalhes do agendamento |
| POST | `/booking` | Publico/Auth | Criar agendamento (autoservico ou manual) |
| PATCH | `/booking/:id` | Opcional | Atualizar status, presenca, avaliacao, nota |
| DELETE | `/booking/:id` | Recrutamento | Cancelar agendamento (deleta evento Calendar) |

### 8.3. Disponibilidade

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/availability` | Opcional | Consultar slots disponiveis por unidade |

Publico: aplica D-rule (D..D+30 dias). Autenticado: full schedule sem restricao.

### 8.4. Configuracao de Horarios

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/schedule` | Recrutamento | Config de horarios (unidade ou global) |
| GET | `/schedule/all` | Recrutamento | Todas as configs ativas |
| PUT | `/schedule` | Recrutamento | Criar/atualizar config |
| DELETE | `/schedule/:id_unidade` | Recrutamento | Remover config |

### 8.5. Bloqueios de Horario

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/schedule-block` | Recrutamento | Listar bloqueios |
| POST | `/schedule-block` | Recrutamento | Criar bloqueio (merge automatico de sobreposicoes) |
| PATCH | `/schedule-block/:id` | Recrutamento | Atualizar bloqueio |
| DELETE | `/schedule-block/:id` | Recrutamento | Remover bloqueio |

### 8.6. Vagas (Jobs)

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/jobs` | Opcional | Listar vagas (status, subregional, busca) |
| GET | `/jobs/status` | Recrutamento | Sync de status com Gupy |
| POST | `/jobs` | Recrutamento | Criar vaga (local + Gupy) |
| PATCH | `/jobs/:id` | Recrutamento | Atualizar vaga |
| DELETE | `/jobs/:id` | Recrutamento | Soft delete |
| POST | `/jobs/:id/publish` | Recrutamento | Publicar vaga |
| POST | `/jobs/batch/publish` | Recrutamento | Publicar em lote |
| POST | `/jobs/batch/close` | Recrutamento | Encerrar em lote |
| POST | `/jobs/batch/cancel` | Recrutamento | Cancelar em lote |
| POST | `/jobs/batch/delete-drafts` | Recrutamento | Deletar rascunhos em lote |

### 8.7. Candidaturas (Applications)

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/applications` | Recrutamento | Listar (filtros: template, step, tag, CPF, busca CV) |
| GET | `/applications/:id` | Recrutamento | Detalhes da candidatura |
| PATCH | `/applications/:id/sync` | Recrutamento | Sync com Gupy |
| POST | `/applications/batch-action` | Recrutamento | Acao em massa (email, mover etapa, tag) |
| POST | `/applications/batch-sync` | Recrutamento | Sync em lote |
| GET | `/applications/sync-status/:jobId` | Recrutamento | Status do sync |

### 8.8. Integracao Gupy

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/gupy/unidades/:id/applications` | Recrutamento | Buscar candidaturas por unidade + CPF |
| GET | `/gupy/jobs/:jobId/applications/:appId` | Recrutamento | Detalhes da candidatura na Gupy |
| GET | `/gupy/jobs` | Recrutamento | Listar vagas da Gupy |
| GET | `/gupy/templates` | Recrutamento | Templates de vaga com campo COD |
| POST | `/gupy/applications/:appId/move-step` | Recrutamento | Mover candidato de etapa |

### 8.9. Eventos (Provas, Exames)

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| POST | `/evento/events/bulk` | Recrutamento | Criar salas em lote |
| GET | `/evento/events` | Recrutamento | Listar eventos |
| GET | `/evento/events/:id` | Recrutamento | Detalhes do evento |
| PATCH | `/evento/events/:id` | Recrutamento | Atualizar evento |
| DELETE | `/evento/events/:id` | Recrutamento | Soft delete |

**Inscricoes em eventos:**

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| POST | `/evento/applications/lookup` | Nao | Candidato verifica elegibilidade |
| POST | `/evento/applications/register` | Nao | Candidato se inscreve em sala |
| PATCH | `/evento/applications/:id/status` | Opcional | Atualizar status de inscricao |

**Monitoramento (fiscal de prova):**

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/evento/monitor` | Fiscal | Monitorar presenca em tempo real |
| PATCH | `/evento/monitor/applications/:id/presence` | Fiscal | Registrar presenca |

**Dashboard e relatorios:**

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/evento/dashboard` | Recrutamento | Estatisticas de eventos |
| POST | `/evento/reports` | Fiscal | Registrar ocorrencia (alerta/eliminatoria) |
| GET | `/evento/reports` | Recrutamento/Fiscal | Listar ocorrencias |

### 8.10. Exame Ocupacional (SALU)

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/exame-ocupacional` | SALU | Listar candidatos (Kanban) |
| GET | `/exame-ocupacional/summary` | SALU | Contagem por status |
| PATCH | `/exame-ocupacional/:id/status` | SALU | Mover no Kanban |
| POST | `/exame-ocupacional/schedule` | SALU | Agendar exame |

**Status pipeline:** pendente → agendado → compareceu → aprovado/reprovado (ou faltou)

### 8.11. Candidatos

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| PUT | `/candidato` | Auth | Upsert candidato + candidatura |
| POST | `/candidato/lookup` | Nao | Busca unificada (Aula Teste + Prova Online) |
| GET | `/candidato/:id/cv` | Recrutamento | CV do candidato (PDF ou JSON) |

### 8.12. Demandas de Ensino

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/demandas` | Demandas | Listar demandas abertas (materia x unidade) |
| PATCH | `/demandas/:cod/:id_unidade/metadata` | Demandas | Atualizar tags/observacoes |
| GET | `/demandas/tags` | Demandas | Tags distintas com contagem |
| GET | `/demandas/subregionais` | Demandas | Lista de subregionais |
| GET | `/demandas/unidades` | Demandas | Lista de unidades |
| GET | `/demandas/disciplinas` | Demandas | Disciplinas disponiveis |
| GET | `/demandas/horarios` | Demandas | Slots de horario por demanda |
| GET | `/demandas/mobilidade-interna` | Demandas | CLTs elegiveis para a demanda |
| GET | `/demandas/colaborador/:id/atribuicoes` | Demandas | Atribuicoes ativas do colaborador |
| GET | `/demandas/candidatos` | Demandas | Candidatos do processo seletivo |

### 8.13. Administracao

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/admin/event-types` | Admin | Listar tipos de evento |
| POST | `/admin/event-types` | Admin | Criar tipo de evento |
| PATCH | `/admin/event-types/:id` | Admin | Atualizar tipo |
| DELETE | `/admin/event-types/:id` | Admin | Deletar tipo |
| GET | `/admin/actions` | Admin | Historico de acoes |
| POST | `/admin/actions/:id/undo` | Admin | Desfazer acao |
| GET | `/admin/subregional` | Recrutamento | Subregionais com unidades |

### 8.14. Unidades

| Metodo | Endpoint | Auth | Descricao |
|--------|----------|------|-----------|
| GET | `/unidade` | Auth | Listar unidades (scoped por role) |
| GET | `/unidade/:id` | Nao | Detalhes da unidade |

---

## 9. Middlewares

### 9.1. Autenticacao (`authMiddleware.js`)

| Middleware | Descricao |
|-----------|-----------|
| `requireAuth` | Valida JWT ou API Key. 401 se invalido |
| `optionalAuth` | Tenta autenticar, nao falha. `req.user` pode ser `undefined` |
| `requireRole(role)` | Verifica role. 403 se nao autorizado |

### 9.2. Validacao de candidatura (`validateApplication.js`)

Middleware especifico para `POST /booking`:
1. Verifica candidatura na Gupy (etapa correta)
2. Verifica historico de no-show (1 falta = bloqueado)
3. Verifica booking ativo para mesma candidatura
4. Retorna 400/403/404 com mensagem especifica

### 9.3. Seguranca (`security.js`)

| Middleware | Descricao |
|-----------|-----------|
| `helmetConfig` | CSP, X-Frame-Options: DENY, XSS-Protection |
| `sanitizeInput` | Remove scripts, `javascript:`, event handlers |
| `generalLimiter` | 1500 req/15min por IP (detecta Cloudflare headers) |
| `authLimiter` | 200 req/5min por IP |

### 9.4. Auditoria (`auditMiddleware.js`)

Registra em log: method, path, user_id, IP, duracao da requisicao.

### 9.5. Cache (`cache.js`)

- Estatico (15min): unidades, cursos, materias, funcoes
- Dinamico (5min): colaboradores, turmas, templates
- Desabilitavel via `DISABLE_CACHE=true`

### 9.6. Erros (`errorHandler.js`)

| Codigo PG | HTTP | Descricao |
|-----------|------|-----------|
| 23503 | 409 | Foreign key violation |
| 23505 | 409 | Unique constraint violation |
| P0001 | 409 | Trigger error (registro duplicado) |
| 42601 | 500 | Erro de sintaxe SQL |
| 42501 | 403 | Permissao negada |
| ECONNREFUSED | 503 | Banco indisponivel |

---

## 10. Servicos e Integracao

### 10.1. Gupy API (`gupyService.js`)

**Objetivo:** Sincronizar vagas, candidaturas e movimentar candidatos na plataforma Gupy.

**Configuracao:**
```env
GUPY_API_KEY=sua-api-key-bearer
GUPY_API_URL=https://api.gupy.io
```

**Operacoes:**
- Listar templates de vaga (com campo COD)
- Criar/atualizar vagas
- Buscar candidaturas por vaga + CPF
- Mover candidato de etapa (ex: "Aula Teste" → "Pre-aprovado")
- Buscar dados de CV do candidato
- Rate limiting via Bottleneck (50 req/s)

**Constantes Gupy** (`constants/gupy.js`):
```env
GUPY_STAGE_AULA_TESTE=Aula Teste
GUPY_STAGE_ENTREVISTA=Entrevista
GUPY_STAGE_PROVA_ONLINE_NEXT=Prova Online e Analise Curricular
GUPY_TAG_AUSENTE_PROVA=ausente-prova-online
GUPY_TAG_ALERT=alerta-prova-online
GUPY_TAG_ELIMINATED=eliminado-prova-online
```

### 10.2. Google Calendar API (`calendarService.js`, `googleCalendar.js`)

**Objetivo:** Criar eventos automaticos com link Google Meet para Aula Teste.

**Configuracao:**
```env
# Service Account (Domain-Wide Delegation)
GOOGLE_SA_KEY_PATH=/path/to/service-account-key.json
# OU variaveis individuais:
GOOGLE_SA_TYPE=service_account
GOOGLE_SA_PROJECT_ID=...
GOOGLE_SA_PRIVATE_KEY=...
GOOGLE_SA_CLIENT_EMAIL=...

GOOGLE_CALENDAR_TIMEZONE=America/Sao_Paulo
GOOGLE_WORKSPACE_DOMAIN=tomeducacao.com.br
EVENT_ORGANIZER=recrutamento@tomeducacao.com.br
EVENT_CALENDAR=id-do-calendario
```

**Fluxo:**
1. Booking criado → `createBookingEvents()` cria 2 eventos (calendario unidade + candidato)
2. Google gera link Meet automaticamente
3. IDs dos eventos salvos no booking (`id_calendar_event_unidade`, `id_calendar_event_candidato`)
4. Booking cancelado → `deleteBookingEvents()` remove os eventos

### 10.3. Google Forms — Rubrica (`rubrica.js`)

**Objetivo:** Gerar URL pre-preenchida do formulario de avaliacao da Aula Teste.

**Configuracao:**
```env
RUBRICA_FORM_BASE=https://docs.google.com/forms/d/e/{FORM_ID}/viewform
RUBRICA_FIELD_BOOKING_ID=entry.xxx
RUBRICA_FIELD_NOME=entry.xxx
RUBRICA_FIELD_CPF=entry.xxx
RUBRICA_FIELD_VAGA=entry.xxx
RUBRICA_FIELD_ESCOLA=entry.xxx
```

### 10.4. Contratacao Automatica (`contratacaoService.js`)

**Objetivo:** Automatizar o fluxo pos-aprovacao: candidato aprovado → colaborador criado no RH Sistema.

**Pipeline:**
1. Booking marcado como `compareceu + aprovado + gerou_interesse`
2. Verifica template elegivel (lista em system_config)
3. Verifica tag "Aprovado - Prova Online"
4. Valida funcao/cargo elegivel para auto-contratacao
5. Calcula salario: `valor_hora_aula * carga_horaria_semanal * 4.33`
6. Cria `pre_employee` (step = `pre_aprovado`)
7. Cria colaborador no RH Sistema via cross-schema
8. Atualiza `pre_employee` (step = `rh_criado`)

**Polling Service:** Monitora `pre_employee` com `step=erro` e retenta automaticamente.

### 10.5. RH Sistema Cross-Schema (`rhSistemaService.js`)

**Objetivo:** Acessar dados do RHSistema principal via queries cross-schema.

**Dados acessados (read-only):**
- Unidades, subregionais, regionais
- Colaboradores e atribuicoes
- Materias e funcoes
- Demandas consolidadas (views)

### 10.6. Event Log (`eventLogService.js`)

**Objetivo:** Trilha de auditoria para todas as acoes do sistema.

**Tipos de evento:** `booking.created`, `booking.attended`, `booking.cancelled`, `admin.schedule_updated`, etc.

**Armazenamento:** Tabela `event_log` com deduplicacao por `event_id`. Fire-and-forget (nao bloqueia a operacao principal).

### 10.7. Email SMTP (`email.js`)

**Objetivo:** Envio de senhas temporarias.

**Configuracao:**
```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user
SMTP_PASS=password
SMTP_FROM=noreply@empresa.com
```

---

## 11. Banco de Dados

### 11.1. Multi-schema

| Schema | Ambiente |
|--------|----------|
| `rs_admissao_homolog` | Homologacao/desenvolvimento |
| `rs_admissao_prod` | Producao |

### 11.2. Cross-schema

O sistema faz JOINs read-only com o schema `rh_sistema_prod` para acessar dados de unidades, colaboradores, funcoes e demandas. Isso e feito via views SQL (`vw_subregional`, `vw_demandas`, `vw_funcao`, `vw_materia_colaborador`).

### 11.3. Tabelas principais

| Tabela | Descricao |
|--------|-----------|
| `job_subregional` | Vagas por subregional (sync com Gupy) |
| `job_unidade` | Mapeamento vaga → unidade |
| `candidate` | Dados do candidato (CPF, CV em JSONB) |
| `application` | Candidaturas (etapa atual, status) |
| `booking` | Agendamentos de Aula Teste |
| `schedule_config` | Config de horarios (manha/tarde, slot_size, D-rule) |
| `schedule_block` | Bloqueios de horario |
| `event` | Eventos genericos (provas, salas) |
| `event_application` | Inscricoes em eventos |
| `event_type` | Tipos de evento (com calendar_id do Google) |
| `exame_ocupacional_candidato` | Pipeline de exames (Kanban) |
| `pre_employee` | Pipeline de contratacao |
| `event_log` | Trilha de auditoria |
| `action_history` | Historico de acoes (suporta undo) |
| `system_config` | Configuracao do sistema (key-value) |
| `salario_config` | Valor hora-aula por funcao |

### 11.4. Conexao

Pool PostgreSQL com as mesmas configs do RHSistema principal:
- Min: 2, Max: 20
- Idle timeout: 5min, Connection timeout: 30s
- Keepalive ativado
- Timezone: `America/Sao_Paulo`
- Dates retornadas como string (sem conversao de timezone)

### 11.5. Migracoes

58 migracoes SQL via `node-pg-migrate`:

```bash
npm run migrate:up:homolog     # Aplicar em homolog
npm run migrate:up:prod        # Aplicar em producao
npm run migrate:status         # Ver status
```

### 11.6. Comandos uteis

```bash
npm run db:init                # Inicializar banco
npm run db:test                # Testar conexao
npm run seed:admin             # Criar usuario admin
npm run deploy:check           # Validacao pre-deploy
```

### 11.7. Advisory Locks

Para prevenir double-booking, o sistema usa **PostgreSQL advisory locks** (`pg_advisory_xact_lock`) no momento de criar um agendamento. O lock e baseado na unidade + horario e e automaticamente liberado ao fim da transacao.

---

## 12. Webhooks

O sistema recebe webhooks da Gupy para manter dados sincronizados.

### 12.1. Admission Webhook

```
POST /api/v1/webhooks/gupy/admission
```

**Evento:** `pre-employee.moved` — candidato avancou no pipeline de admissao.

**Acoes:**
1. Deduplicacao por `event_id` (cache 1h)
2. Atualiza `pre_employee`: step_id, step_name, id_admission
3. Se step = "SEND_DOCUMENTS" ou "Dados a Enviar Para Salu": cria registro em `exame_ocupacional_candidato`

### 12.2. Application Created Webhook

```
POST /api/v1/webhooks/gupy/application-created
```

**Evento:** Candidatura criada na Gupy.

**Acoes:** Sync da candidatura para o banco local.

### 12.3. Application Moved Webhook

```
POST /api/v1/webhooks/gupy/application-moved
```

**Evento:** Candidato moveu de etapa na Gupy.

**Acoes:** Atualiza `current_step_name` e `current_step_status` da candidatura.

> **Nota:** Webhooks nao tem autenticacao (confiar na origem). Respostas sao idempotentes.

---

## 13. Deploy com Docker

### 13.1. Dockerfile

```dockerfile
FROM node:20-bullseye-slim
WORKDIR /app
COPY package*.json ./
RUN apt-get update && \
    apt-get install -y build-essential python3 make gcc g++ && \
    npm ci --production && \
    apt-get remove -y build-essential python3 make gcc g++ && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*
COPY . ./
ENV NODE_ENV=production
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:4001/health || exit 1
CMD ["node", "server.js"]
```

### 13.2. Build e execucao

```bash
docker build -t rs-admissao-backend .

docker run -d \
  --name rs-admissao \
  -p 4001:4001 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/db \
  -e DB_SCHEMA=rs_admissao_prod \
  -e NODE_ENV=production \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e FRONTEND_ORIGIN=https://recrutamento.rhsistema.com.br \
  -e GUPY_API_KEY=sua-key \
  -e GUPY_API_URL=https://api.gupy.io \
  rs-admissao-backend
```

---

## 14. Deploy em Producao (Lightsail)

O processo e similar ao do RHSistema principal:

### 14.1. Servidor

1. Instancia Lightsail com blueprint Node.js ($7+/mes)
2. IP estatico associado
3. Nginx como proxy reverso (porta 80 → 4001)

### 14.2. Nginx

```nginx
server {
    listen 80;
    server_name recrutamento-api.seudominio.com;

    location / {
        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 14.3. Configurar backend

```bash
cd ~
git clone <repo-url> v0-backend-rs-admissao
cd v0-backend-rs-admissao
npm ci --production

# Configurar .env (ver secao 17)
nano .env

# Testar conexao e inicializar
npm run db:test
npm run migrate:up:prod
npm run seed:admin
```

### 14.4. PM2

```bash
sudo npm install -g pm2
pm2 start server.js --name "rs-admissao"
pm2 save
pm2 startup
```

### 14.5. DNS e SSL

Mesmo processo do RHSistema: registro A no Cloudflare → proxy ON → SSL Flexible.

### 14.6. Deploy manual (atualizacao)

```bash
ssh -i chave.pem usuario@servidor
cd ~/v0-backend-rs-admissao
git pull origin main
npm ci --production
npm run migrate:up:prod
pm2 restart rs-admissao
curl http://localhost:4001/health
```

---

## 15. CI/CD com GitHub Actions

### 15.1. Deploy Develop (`deploy-develop.yml`)

**Trigger:** Push em `develop`

Faz deploy automatico no servidor de homologacao via SSH.

### 15.2. Deploy Main (`deploy-main.yml`)

**Trigger:** Push em `main`

Faz deploy automatico no servidor de producao via SSH.

### 15.3. Migracoes (`run-migrations.yml`)

**Trigger:** Manual (workflow_dispatch)

Executa migracoes no servidor selecionado.

### 15.4. Secrets necessarios

| Secret | Descricao |
|--------|-----------|
| `DEV_SSH_HOST` | IP homolog |
| `DEV_SSH_USER` | Usuario SSH homolog |
| `DEV_SSH_KEY` | Chave privada homolog |
| `PROD_SSH_HOST` | IP producao |
| `PROD_SSH_USER` | Usuario SSH producao |
| `PROD_SSH_KEY` | Chave privada producao |

---

## 16. Seguranca

### 16.1. Autenticacao

- JWT HS256, 8h expiracao, secret min 32 chars
- API Keys com hash bcrypt, cache 5min
- Senhas: bcrypt com salt rounds

### 16.2. Headers (Helmet)

- CSP: bloqueia inline scripts
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- X-XSS-Protection: 1; mode=block

### 16.3. Rate limiting

- Geral: 1500 req/15min por IP
- Auth: 200 req/5min por IP
- Detecta IP real via Cloudflare (CF-Connecting-IP)

### 16.4. CORS

Whitelist de origens:
- `localhost:3000`
- `recrutamento-dev.rhsistema.com.br`
- `recrutamento-homolog.rhsistema.com.br`
- `recrutamento.rhsistema.com.br`
- `FRONTEND_ORIGIN` (env var)

### 16.5. Sanitizacao de input

Remove recursivamente: `<script>`, `javascript:`, event handlers HTML.

### 16.6. Advisory locks

Previne double-booking via `pg_advisory_xact_lock` em transacoes.

### 16.7. Validacao de startup

- `JWT_SECRET` obrigatorio em producao
- `DB_SCHEMA` validado contra `NODE_ENV`
- Alerta se schema nao corresponde ao ambiente

---

## 17. Variaveis de Ambiente

### Obrigatorias

| Variavel | Descricao | Exemplo |
|----------|-----------|---------|
| `DATABASE_URL` | Connection string PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `DB_SCHEMA` | Schema do banco | `rs_admissao_prod` ou `rs_admissao_homolog` |
| `NODE_ENV` | Ambiente | `development`, `homolog`, `production` |
| `PORT` | Porta do servidor | `4001` |
| `JWT_SECRET` | Chave JWT (min 32 chars em prod) | `openssl rand -hex 32` |
| `FRONTEND_ORIGIN` | URL do frontend para CORS | `https://recrutamento.rhsistema.com.br` |

### Gupy (obrigatorio para integracao)

| Variavel | Descricao | Exemplo |
|----------|-----------|---------|
| `GUPY_API_KEY` | Bearer token da API Gupy | `uuid-da-key` |
| `GUPY_API_URL` | URL base da API | `https://api.gupy.io` |
| `GUPY_STAGE_AULA_TESTE` | Nome da etapa Aula Teste | `Aula Teste` |
| `GUPY_STAGE_ENTREVISTA` | Nome da etapa Entrevista | `Entrevista` |
| `GUPY_STAGE_PROVA_ONLINE_NEXT` | Nome da etapa pos-prova | `Prova Online e Analise Curricular` |
| `GUPY_TAG_AUSENTE_PROVA` | Tag de ausente | `ausente-prova-online` |
| `GUPY_TAG_ALERT` | Tag de alerta | `alerta-prova-online` |
| `GUPY_TAG_ELIMINATED` | Tag de eliminado | `eliminado-prova-online` |

### Google Calendar

| Variavel | Descricao | Exemplo |
|----------|-----------|---------|
| `GOOGLE_SA_KEY_PATH` | Caminho para JSON do Service Account | `/path/to/key.json` |
| `GOOGLE_CALENDAR_TIMEZONE` | Timezone do calendario | `America/Sao_Paulo` |
| `GOOGLE_WORKSPACE_DOMAIN` | Dominio Workspace | `tomeducacao.com.br` |
| `EVENT_ORGANIZER` | Email do organizador | `recrutamento@tomeducacao.com.br` |
| `EVENT_CALENDAR` | ID do calendario Google | `calendar-id` |

### Rubrica (Google Forms)

| Variavel | Descricao |
|----------|-----------|
| `RUBRICA_FORM_BASE` | URL base do formulario |
| `RUBRICA_FIELD_BOOKING_ID` | Entry ID campo booking |
| `RUBRICA_FIELD_NOME` | Entry ID campo nome |
| `RUBRICA_FIELD_CPF` | Entry ID campo CPF |
| `RUBRICA_FIELD_VAGA` | Entry ID campo vaga |
| `RUBRICA_FIELD_ESCOLA` | Entry ID campo escola |

### Email SMTP (opcional)

| Variavel | Descricao | Exemplo |
|----------|-----------|---------|
| `SMTP_HOST` | Host SMTP | `smtp.gmail.com` |
| `SMTP_PORT` | Porta | `587` |
| `SMTP_USER` | Usuario | `user@gmail.com` |
| `SMTP_PASS` | Senha | `app-password` |
| `SMTP_FROM` | Remetente | `noreply@empresa.com` |

### Banco de dados

| Variavel | Descricao |
|----------|-----------|
| `DB_SSL` | Habilitar SSL (`true`/`false`) |
| `DB_SSL_REJECT_UNAUTHORIZED` | Verificar certificado (`false` para dev) |

### Feature flags

| Variavel | Descricao | Default |
|----------|-----------|---------|
| `ENABLE_CONTRATACAO_POLLING` | Polling para retry de contratacoes com erro | `false` |
| `DISABLE_CACHE` | Desabilitar cache em memoria | `false` |
| `ENABLE_SWAGGER` | Habilitar `/api-docs` | `false` |
| `DETAILED_ERRORS` | Erros detalhados na resposta | `false` |

### Rate limiting

| Variavel | Descricao | Default |
|----------|-----------|---------|
| `RATE_LIMIT_WINDOW_MS` | Janela em ms | `900000` (15min) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests por janela | `1500` |

### Seed

| Variavel | Descricao |
|----------|-----------|
| `ADMIN_EMAIL` | Email do admin inicial |
| `ADMIN_PASSWORD` | Senha do admin inicial |

---

## 18. Troubleshooting

### Problemas comuns

| Problema | Solucao |
|----------|---------|
| Database connection refused | Verificar `DATABASE_URL` e `DB_SSL`. Rodar `npm run db:test` |
| CORS errors no frontend | Verificar `FRONTEND_ORIGIN` no `.env` e whitelist em `server.js` |
| JWT token expired | Tokens expiram em 8h. Fazer login novamente |
| Gupy API retornando 401 | Verificar `GUPY_API_KEY` — a key pode ter expirado |
| Gupy API retornando 429 | Rate limit da Gupy atingido. O sistema tem Bottleneck (50 req/s) |
| Calendar event nao criado | Verificar credenciais Google Service Account e permissoes de Workspace |
| Double-booking ocorrendo | Advisory lock pode ter falhado. Verificar logs de transacao |
| Webhook nao recebido | Verificar URL do webhook na Gupy e se endpoint esta acessivel externamente |
| Migrations fail | `npm run migrate:status` para ver estado. Verificar schema correto |
| Pre-employee com step=erro | `ENABLE_CONTRATACAO_POLLING=true` para retry automatico |
| Schema not found | Verificar `DB_SCHEMA` e se o schema existe no banco |

### Comandos de diagnostico

```bash
# Status PM2
pm2 list

# Logs
pm2 logs --lines 300
tail -200 ~/.pm2/logs/rs-admissao-out.log
tail -200 ~/.pm2/logs/rs-admissao-error.log

# Health check
curl http://localhost:4001/health

# Validacao pre-deploy
npm run deploy:check

# Status de migracoes
npm run migrate:status

# Testar conexao
npm run db:test
```

---

## Dependencias Principais

| Pacote | Versao | Funcao |
|--------|--------|--------|
| `express` | 4.18.2 | Framework web |
| `pg` | 8.11.0 | Driver PostgreSQL |
| `jsonwebtoken` | 9.0.0 | Tokens JWT |
| `bcrypt` / `bcryptjs` | 5.1.0 / 3.0.2 | Hash de senhas |
| `axios` | 1.12.2 | Cliente HTTP (Gupy API) |
| `googleapis` | 164.1.0 | Google Calendar/Drive API |
| `bottleneck` | 2.19.5 | Rate limiter avancado |
| `pdfkit` | 0.17.2 | Geracao de PDF (CV) |
| `cors` | 2.8.5 | CORS middleware |
| `helmet` | 8.1.0 | Headers de seguranca |
| `express-rate-limit` | 8.1.0 | Rate limiting |
| `express-validator` | 7.2.1 | Validacao de input |
| `nodemailer` | 6.9.3 | Envio de email |
| `xlsx` | 0.18.5 | Exportacao Excel |
| `moment` / `moment-timezone` | 2.29.4 / 0.6.0 | Datas com timezone |
| `node-cache` | 5.1.2 | Cache em memoria |
| `dotenv` | 16.0.0 | Variaveis de ambiente |

**Dev:**
| Pacote | Versao | Funcao |
|--------|--------|--------|
| `jest` | 30.1.3 | Framework de testes |
| `supertest` | 7.1.4 | Testes HTTP |
| `nock` | 14.0.10 | Mock de HTTP |
| `nodemon` | 3.1.11 | Auto-reload em dev |
| `node-pg-migrate` | 8.0.3 | Migracoes |
