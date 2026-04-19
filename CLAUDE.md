# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

**Repository:** v0-backend-rs-admissao
**GitHub:** https://github.com/techTOMAPG/v0-backend-rs-admissao
**Purpose:** Independent module for Recruitment & Selection (R&S) and Admissions (Agendamento de Aulas Teste)

This is a **separate project** that shares the same database server with the main RH Sistema, but runs on independent infrastructure with its own schemas.

---

## CRITICAL: Git Workflow Rules

**NEVER commit directly to `main` or `develop` branches!**

### Mandatory Workflow

```
1. ALWAYS create a feature branch from develop
2. Code and test in the feature branch
3. Commit to feature branch with proper commit message
4. Push feature branch and create PR to develop
5. After testing in develop, create PR from develop to main
```

### Before ANY Code Change

```bash
# 1. Make sure you're on develop and up to date
git checkout develop
git pull origin develop

# 2. Create a feature branch
git checkout -b <type>/<description>

# Examples:
git checkout -b feature/add-booking-validation
git checkout -b fix/cors-www-variant
git checkout -b refactor/slot-generator
git checkout -b docs/api-documentation
```

### Branch Naming Convention

| Type | Use For | Example |
|------|---------|---------|
| `feature/` | New features | `feature/google-calendar-sync` |
| `fix/` | Bug fixes | `fix/booking-timezone` |
| `hotfix/` | Production emergencies | `hotfix/auth-bypass` |
| `refactor/` | Code improvements | `refactor/booking-service` |
| `docs/` | Documentation | `docs/api-endpoints` |
| `test/` | Test additions | `test/booking-unit-tests` |
| `chore/` | Maintenance | `chore/dependency-updates` |

### Commit Message Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`

**Scopes:** `booking`, `auth`, `schedule`, `gupy`, `calendar`, `api`, `db`, `deps`

**Examples:**
```bash
# Simple commit
git commit -m "feat(booking): add slot cancellation endpoint"

# With body
git commit -m "fix(auth): resolve JWT token refresh race condition

The previous implementation allowed concurrent refresh requests
to invalidate each other's tokens. Now uses atomic operations.

Fixes #123"

# Breaking change
git commit -m "feat(api)!: change booking response format

BREAKING CHANGE: Booking response now includes nested unit info."
```

### After Coding - Push and PR

```bash
# 1. Push your feature branch
git push -u origin <branch-name>

# 2. Create PR to develop
gh pr create --base develop --title "<type>: <description>"

# 3. Wait for CI to pass, then merge (squash)
gh pr merge --squash

# 4. After testing in develop, promote to main
gh pr create --base main --head develop --title "release: <description>"
```

### FORBIDDEN Actions

- **NEVER** `git push origin develop` directly
- **NEVER** `git push origin main` directly
- **NEVER** `git commit` while on `develop` or `main` branch
- **NEVER** skip tests before pushing
- **NEVER** commit secrets, .env files, or credentials

---

## Quick Reference

```bash
# Development (ALWAYS use homolog schema)
npm run dev:homolog           # Start with rs_admissao_homolog schema

# Testing (ALWAYS run before committing)
npm test                      # Run Jest tests

# Migrations
npm run migrate:status        # Show migration status
npm run migrate:dry-run       # Preview pending migrations
npm run migrate:up:homolog    # Apply to homolog schema
npm run migrate:up:prod       # Apply to prod schema (use with caution!)

# Database (via MCP postgres tool or psql)
# Schema: rs_admissao_homolog (dev) or rs_admissao_prod (production)
```

---

## Code Style Guidelines

### JavaScript/Node.js

```javascript
// Use async/await, not callbacks
async function getBooking(id) {
  const result = await db.query('SELECT * FROM booking WHERE id = $1', [id]);
  return result.rows[0];
}

// Always use parameterized queries (prevent SQL injection)
// GOOD:
await db.query('SELECT * FROM booking WHERE id = $1', [id]);

// BAD - SQL INJECTION VULNERABLE:
await db.query(`SELECT * FROM booking WHERE id = ${id}`);

// Use try/catch with proper error handling
try {
  const result = await someOperation();
  return res.json({ success: true, data: result });
} catch (error) {
  console.error('[endpoint] Error:', error.message);
  return res.status(500).json({ success: false, error: 'Operation failed' });
}

// Use transactions for multi-step operations
const client = await db.getClient();
try {
  await client.query('BEGIN');
  // ... operations ...
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

### API Response Format

```javascript
// Success response
res.json({
  success: true,
  data: result,
  message: 'Optional message'
});

// Error response
res.status(400).json({
  success: false,
  error: 'Error description'
});

// List response with pagination
res.json({
  success: true,
  data: items,
  pagination: {
    total: 100,
    page: 1,
    limit: 20
  }
});
```

### Route Structure

```javascript
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const db = require('../../db');

// GET /api/v1/resource
router.get('/', requireAuth, requireRecrutamento, async (req, res) => {
  try {
    // Implementation
  } catch (error) {
    console.error('[GET /resource] Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch resources' });
  }
});

module.exports = router;
```

### Validation

```javascript
const { body, param, query, validationResult } = require('express-validator');

// Route with validation
router.post('/',
  requireAuth,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Invalid email'),
    body('date').isISO8601().withMessage('Invalid date format'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    // ... rest of handler
  }
);
```

---

## Testing Requirements

### Before Committing

1. **Run tests locally:**
   ```bash
   npm test
   ```

2. **Ensure no console.log debugging statements** (use proper logging)

3. **Check for security issues:**
   - No hardcoded secrets
   - Parameterized SQL queries
   - Input validation on all endpoints

### Writing Tests

```javascript
// Test file: tests/routes/myroute.test.js
const request = require('supertest');
const express = require('express');

// Mock dependencies
jest.mock('../../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../src/middleware/authMiddleware', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 1, role: 'admin' };
    next();
  },
}));

const db = require('../../db');
const myRouter = require('../../src/routes/myroute');

const app = express();
app.use(express.json());
app.use('/myroute', myRouter);

describe('MyRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /', () => {
    it('should return list of items', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 1, name: 'Test' }] });

      const res = await request(app).get('/myroute');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 500 on database error', async () => {
      db.query.mockRejectedValue(new Error('DB error'));

      const res = await request(app).get('/myroute');

      expect(res.status).toBe(500);
    });
  });
});
```

---

## Environment & Schema Management

This application uses **multi-schema PostgreSQL** with cross-schema foreign key references:

| Environment | Schema | Referenced Schema |
|-------------|--------|-------------------|
| Production | `rs_admissao_prod` | `rh_sistema_prod.unidade`, `rh_sistema_prod.regional` |
| Homolog | `rs_admissao_homolog` | `rh_sistema_homolog.unidade`, `rh_sistema_homolog.regional` |

**Critical Rules:**
- ALWAYS use `npm run dev:homolog` for development
- NEVER run with production schema during development
- The `DB_SCHEMA` environment variable controls which schema is used
- `db.js` automatically sets `search_path` and timezone (`America/Sao_Paulo`) on every connection

---

## CI/CD Pipeline (GitHub Actions)

### Workflows

| Workflow | Trigger | Environment | Actions |
|----------|---------|-------------|---------|
| `deploy-develop.yml` | Push to `develop` | develop | Test → Deploy → Health check |
| `deploy-main.yml` | Push to `main` | production | Test → Deploy → Health check |
| `run-migrations.yml` | Manual dispatch | selectable | Run pending migrations |

### Deployment Servers

| Environment | Server | IP |
|-------------|--------|-----|
| Homolog | AWS Lightsail | 3.131.46.62 |
| Production | AWS Lightsail | 52.23.123.223 |

---

## Migrations

### Creating New Migrations

```bash
# Create new migration file
npm run migrate:create my_feature_name
# Edit the generated file in migrations/
```

### Migration Best Practices

1. **Always test in homolog first**
2. **Wrap in transactions:**
   ```sql
   BEGIN;
   -- Your DDL/DML here
   COMMIT;
   ```
3. **Make migrations idempotent:**
   ```sql
   CREATE TABLE IF NOT EXISTS my_table (...);
   ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_col TEXT;
   ```
4. **One logical change per file**

---

## Architecture Overview

### Core Domain: Scheduling System (Agendamento de Aulas Teste)

**Public API** for candidates to schedule test classes:
- `GET /api/v1/public/bookings/availability` - Query available slots
- `POST /api/v1/public/bookings` - Create booking with Google Calendar event
- `DELETE /api/v1/public/bookings/:id` - Cancel booking

**Admin API** for recruitment team:
- `/api/v1/admin/bookings` - Booking management
- `/api/v1/admin/schedule-config` - Global and per-unit slot configuration
- `/api/v1/admin/schedule-blocks` - Temporary blocks

### RBAC System

- **admin**: Full system access across all units
- **coordenador**: Restricted to assigned unit (`id_unidade`)

Middleware stack:
1. `requireAuth` - Validates JWT, sets `req.user`
2. `requireRecrutamento` - Requires admin or coordenador
3. `requireUnitOrAdmin` - Unit-based authorization

### Key Business Rules

**Zero PII Policy:**
- NEVER persist candidate personal data (name, email, phone, CPF)
- Only store Gupy references: `id_application_gupy`, `id_job_gupy`
- Fetch candidate data from Gupy API on-demand

**Booking Status Enum:** `'agendado'` | `'compareceu'` | `'faltou'` | `'cancelado'`

---

## Database Patterns

**Transactions with FOR UPDATE** (prevent race conditions):
```javascript
const client = await db.getClient();
try {
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM booking WHERE ... FOR UPDATE');
  // Create booking only if slot is available
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

**Soft Deletes:** Tables use `ativo` boolean flag. Query with `WHERE ativo = true`.

**Foreign Key Convention:** `id_{table_name}` (e.g., `id_unidade`, `id_booking`)

---

## Key Files Reference

**Core Application:**
- `server.js` - Entry point, route registration
- `db.js` - PostgreSQL connection pool

**Scheduling System:**
- `src/routes/booking.js` - Booking CRUD
- `src/routes/availability.js` - Slot availability
- `src/routes/schedule.js` - Schedule configuration
- `src/routes/schedule-block.js` - Schedule blocks
- `src/lib/slotGenerator.js` - Slot generation logic

**Event System (Prova Teorica):**
- `src/routes/evento/events.js` - Event CRUD
- `src/routes/evento/applications.js` - Event applications
- `src/routes/evento/dashboard.js` - Reporting

**Authentication:**
- `src/routes/auth.js` - JWT generation/verification
- `src/middleware/authMiddleware.js` - `requireAuth`
- `src/middleware/rbac.js` - Role-based access

**Integrations:**
- `src/lib/googleCalendar.js` - Google Calendar API
- `src/services/gupyService.js` - Gupy ATS API

---

## Security

### NEVER Commit These Files

- `.env` (use `.env.example` as template)
- `*.pem` (SSH keys)
- `credentials.json` (Google service account)
- Any file containing API keys or passwords

### External Integrations - CAUTION

**Gupy API:** Performs WRITE operations. Production key in homolog WILL affect real data.

**Google Calendar:** Creates real calendar events in both environments.

---

## Documentation

- `docs/DEVOPS_FRAMEWORK.md` - Complete DevOps workflow documentation
- `docs/ARCHITECTURE.md` - System architecture overview
- `docs/DATA_MODEL.md` - Database schema and relationships
- `docs/BOOKING_BUSINESS_RULES.md` - Booking system rules

---

## Checklist Before Creating PR

- [ ] Created feature branch from `develop`
- [ ] All tests pass (`npm test`)
- [ ] No console.log debugging statements
- [ ] No hardcoded secrets
- [ ] Commit messages follow convention
- [ ] Code follows style guidelines
- [ ] Input validation on new endpoints
- [ ] Parameterized SQL queries (no SQL injection)
- [ ] Updated documentation if needed
