const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireRecrutamento } = require('../middleware/rbac');
const { logEvent } = require('../services/eventLogService');

// Helper to normalize date to YYYY-MM-DD string
function toDateString(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).substring(0, 10);
}

router.get('/', requireAuth, requireRecrutamento,
  [query('id_unidade').optional().isInt(), query('active').optional().isBoolean()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { id_unidade, active } = req.query;
      const activeFilter = active !== 'false';
      let whereClause = 'WHERE sb.active = $1';
      const params = [activeFilter];
      if (id_unidade) { whereClause += ' AND sb.id_unidade = $2'; params.push(id_unidade); }
      const result = await db.query(`SELECT sb.*, u.nome_unidade FROM schedule_block sb JOIN unidade u ON u.id_unidade = sb.id_unidade ${whereClause} ORDER BY sb.block_from DESC`, params);
      return res.json({ success: true, data: result.rows });
    } catch (error) {
      console.error('[ScheduleBlock GET] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar bloqueios' });
    }
  }
);

router.post('/', requireAuth, requireRecrutamento,
  [
    body('id_unidade').notEmpty().isInt(),
    body('blocked_start_at').notEmpty().matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('blocked_end_at').notEmpty().matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('block_from').notEmpty().isISO8601(),
    body('block_until').notEmpty().isISO8601(),
    body('reason').optional().isString().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { id_unidade, blocked_start_at, blocked_end_at, block_from, block_until, reason } = req.body;

      // Normalize times to HH:MM format
      const newTimeStart = blocked_start_at.substring(0, 5);
      const newTimeEnd = blocked_end_at.substring(0, 5);

      if (new Date(block_until) < new Date(block_from)) {
        return res.status(400).json({ success: false, error: 'block_until deve ser >= block_from' });
      }

      await client.query('BEGIN');

      // 1. Find overlapping blocks (same unit, active, overlapping dates AND times)
      const overlappingResult = await client.query(`
        SELECT * FROM schedule_block
        WHERE id_unidade = $1
          AND active = true
          AND block_from <= $3
          AND block_until >= $2
          AND blocked_start_at < $5
          AND blocked_end_at > $4
        FOR UPDATE
      `, [id_unidade, block_from, block_until, newTimeStart, newTimeEnd]);

      const overlappingBlocks = overlappingResult.rows;

      // 2. Check for exact duplicate
      const exactDuplicate = overlappingBlocks.find(b => {
        const bTimeStart = b.blocked_start_at.substring(0, 5);
        const bTimeEnd = b.blocked_end_at.substring(0, 5);
        const bDateFrom = toDateString(b.block_from);
        const bDateUntil = toDateString(b.block_until);
        return bDateFrom === block_from &&
               bDateUntil === block_until &&
               bTimeStart === newTimeStart &&
               bTimeEnd === newTimeEnd;
      });

      if (exactDuplicate) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'Block idêntico já existe para esta unidade',
          existing_block: {
            id_block: exactDuplicate.id_block,
            blocked_start_at: exactDuplicate.blocked_start_at,
            blocked_end_at: exactDuplicate.blocked_end_at,
            block_from: exactDuplicate.block_from,
            block_until: exactDuplicate.block_until,
          }
        });
      }

      // 3. Calculate merged range if there are overlapping blocks
      let mergedTimeStart = newTimeStart;
      let mergedTimeEnd = newTimeEnd;
      let mergedDateFrom = block_from;
      let mergedDateUntil = block_until;
      const mergedBlockIds = [];

      if (overlappingBlocks.length > 0) {
        for (const block of overlappingBlocks) {
          const bTimeStart = block.blocked_start_at.substring(0, 5);
          const bTimeEnd = block.blocked_end_at.substring(0, 5);
          const bDateFrom = toDateString(block.block_from);
          const bDateUntil = toDateString(block.block_until);

          // Expand time range
          if (bTimeStart < mergedTimeStart) mergedTimeStart = bTimeStart;
          if (bTimeEnd > mergedTimeEnd) mergedTimeEnd = bTimeEnd;

          // Expand date range
          if (bDateFrom < mergedDateFrom) mergedDateFrom = bDateFrom;
          if (bDateUntil > mergedDateUntil) mergedDateUntil = bDateUntil;

          mergedBlockIds.push(block.id_block);
        }

        // Delete overlapping blocks
        await client.query('DELETE FROM schedule_block WHERE id_block = ANY($1)', [mergedBlockIds]);
      }

      // 4. Insert new block (original or merged)
      const result = await client.query(`
        INSERT INTO schedule_block (id_unidade, blocked_start_at, blocked_end_at, block_from, block_until, reason, created_by, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        RETURNING *
      `, [id_unidade, mergedTimeStart, mergedTimeEnd, mergedDateFrom, mergedDateUntil, reason || null, req.user?.id_usuario || null]);

      await client.query('COMMIT');

      const responseData = {
        success: true,
        data: result.rows[0],
      };

      // Add merge info if blocks were merged
      if (mergedBlockIds.length > 0) {
        responseData.merged = {
          count: mergedBlockIds.length,
          deleted_block_ids: mergedBlockIds,
        };
      }

      req._eventLogged = true;
      logEvent({
        eventType: 'admin.block_created',
        entityType: 'schedule_block',
        entityId: String(result.rows[0].id_block),
        actorType: 'admin',
        actorId: req.user?.id?.toString(),
        actorName: req.user?.nome,
        metadata: { idUnidade: result.rows[0].id_unidade, blockFrom: result.rows[0].block_from, blockUntil: result.rows[0].block_until },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.status(201).json(responseData);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[ScheduleBlock POST] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao criar bloqueio' });
    } finally {
      client.release();
    }
  }
);

router.patch('/:id', requireAuth, requireRecrutamento,
  [
    param('id').isInt(),
    body('blocked_start_at').optional().matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('blocked_end_at').optional().matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('block_from').optional().isISO8601(),
    body('block_until').optional().isISO8601(),
    body('reason').optional().isString().isLength({ max: 500 }),
    body('active').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const { id } = req.params;
      const allowedFields = ['blocked_start_at', 'blocked_end_at', 'block_from', 'block_until', 'reason', 'active'];
      const setClauses = []; const values = []; let idx = 1;
      for (const f of allowedFields) { if (req.body[f] !== undefined) { setClauses.push(`${f} = $${idx}`); values.push(req.body[f]); idx++; } }
      if (setClauses.length === 0) return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
      setClauses.push('updated_at = NOW()'); values.push(id);
      const result = await db.query(`UPDATE schedule_block SET ${setClauses.join(', ')} WHERE id_block = $${idx} RETURNING *`, values);
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Bloqueio não encontrado' });
      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('[ScheduleBlock PATCH] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao atualizar bloqueio' });
    }
  }
);

router.delete('/:id', requireAuth, requireRecrutamento, [param('id').isInt()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
      const result = await db.query(`DELETE FROM schedule_block WHERE id_block = $1 RETURNING id_block`, [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Bloqueio não encontrado' });
      req._eventLogged = true;
      logEvent({
        eventType: 'admin.block_removed',
        entityType: 'schedule_block',
        entityId: String(req.params.id),
        actorType: 'admin',
        actorId: req.user?.id?.toString(),
        actorName: req.user?.nome,
        metadata: { idBlock: parseInt(req.params.id), idUnidade: null },
        source: 'system',
        eventTimestamp: new Date(),
      });
      return res.json({ success: true, message: 'Bloqueio removido' });
    } catch (error) {
      console.error('[ScheduleBlock DELETE] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao remover bloqueio' });
    }
  }
);

/**
 * POST /release - Libera um range de horários, dividindo bloqueios se necessário
 *
 * Se o range liberado cobre 100% de um bloqueio → deleta
 * Se cobre parcialmente → divide em fragmentos
 */
router.post('/release', requireAuth, requireRecrutamento,
  [
    body('id_unidade').notEmpty().isInt(),
    body('date_start').notEmpty().isISO8601(),
    body('date_end').notEmpty().isISO8601(),
    body('time_start').notEmpty().matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('time_end').notEmpty().matches(/^\d{2}:\d{2}(:\d{2})?$/),
  ],
  async (req, res) => {
    const client = await db.getClient();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { id_unidade, date_start, date_end, time_start, time_end } = req.body;
      const releaseDateStart = new Date(date_start);
      const releaseDateEnd = new Date(date_end);
      const releaseTimeStart = time_start.substring(0, 5);
      const releaseTimeEnd = time_end.substring(0, 5);

      if (releaseDateEnd < releaseDateStart) {
        return res.status(400).json({ success: false, error: 'date_end deve ser >= date_start' });
      }

      await client.query('BEGIN');

      // Buscar bloqueios que intersectam o range (por data E horário)
      const blocksResult = await client.query(`
        SELECT * FROM schedule_block
        WHERE id_unidade = $1
          AND active = true
          AND block_from <= $3
          AND block_until >= $2
          AND blocked_start_at < $5
          AND blocked_end_at > $4
        FOR UPDATE
      `, [id_unidade, date_start, date_end, releaseTimeStart, releaseTimeEnd]);

      const blocks = blocksResult.rows;
      const deleted = [];
      const created = [];

      for (const block of blocks) {
        const blockDateStart = new Date(block.block_from);
        const blockDateEnd = new Date(block.block_until);
        const blockTimeStart = block.blocked_start_at.substring(0, 5);
        const blockTimeEnd = block.blocked_end_at.substring(0, 5);

        // Verificar se o release cobre 100% do bloqueio
        const coversAllDates = releaseDateStart <= blockDateStart && releaseDateEnd >= blockDateEnd;
        const coversAllTime = releaseTimeStart <= blockTimeStart && releaseTimeEnd >= blockTimeEnd;

        if (coversAllDates && coversAllTime) {
          // Deleta o bloqueio inteiro
          await client.query('DELETE FROM schedule_block WHERE id_block = $1', [block.id_block]);
          deleted.push(block.id_block);
        } else {
          // Precisa dividir - deletar original e criar fragmentos
          await client.query('DELETE FROM schedule_block WHERE id_block = $1', [block.id_block]);
          deleted.push(block.id_block);

          const fragments = [];

          // Fragmento 1: Dias ANTES do range liberado (mantém horário original)
          if (blockDateStart < releaseDateStart) {
            const dayBefore = new Date(releaseDateStart);
            dayBefore.setDate(dayBefore.getDate() - 1);
            fragments.push({
              block_from: blockDateStart.toISOString().split('T')[0],
              block_until: dayBefore.toISOString().split('T')[0],
              blocked_start_at: blockTimeStart,
              blocked_end_at: blockTimeEnd,
            });
          }

          // Fragmento 2: Dias DEPOIS do range liberado (mantém horário original)
          if (blockDateEnd > releaseDateEnd) {
            const dayAfter = new Date(releaseDateEnd);
            dayAfter.setDate(dayAfter.getDate() + 1);
            fragments.push({
              block_from: dayAfter.toISOString().split('T')[0],
              block_until: blockDateEnd.toISOString().split('T')[0],
              blocked_start_at: blockTimeStart,
              blocked_end_at: blockTimeEnd,
            });
          }

          // Para os dias dentro do range liberado, criar fragmentos de horário
          const overlapDateStart = releaseDateStart > blockDateStart ? releaseDateStart : blockDateStart;
          const overlapDateEnd = releaseDateEnd < blockDateEnd ? releaseDateEnd : blockDateEnd;

          // Fragmento 3: Horário ANTES do range liberado (nos dias de overlap)
          if (blockTimeStart < releaseTimeStart) {
            fragments.push({
              block_from: overlapDateStart.toISOString().split('T')[0],
              block_until: overlapDateEnd.toISOString().split('T')[0],
              blocked_start_at: blockTimeStart,
              blocked_end_at: releaseTimeStart,
            });
          }

          // Fragmento 4: Horário DEPOIS do range liberado (nos dias de overlap)
          if (blockTimeEnd > releaseTimeEnd) {
            fragments.push({
              block_from: overlapDateStart.toISOString().split('T')[0],
              block_until: overlapDateEnd.toISOString().split('T')[0],
              blocked_start_at: releaseTimeEnd,
              blocked_end_at: blockTimeEnd,
            });
          }

          // Inserir fragmentos válidos
          for (const frag of fragments) {
            // Validar que o fragmento faz sentido (datas e horários válidos)
            if (new Date(frag.block_until) >= new Date(frag.block_from) &&
                frag.blocked_end_at > frag.blocked_start_at) {
              const insertResult = await client.query(`
                INSERT INTO schedule_block (id_unidade, blocked_start_at, blocked_end_at, block_from, block_until, reason, created_by, active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, true)
                RETURNING id_block
              `, [id_unidade, frag.blocked_start_at, frag.blocked_end_at, frag.block_from, frag.block_until, block.reason, req.user?.id_usuario || null]);
              created.push(insertResult.rows[0].id_block);
            }
          }
        }
      }

      await client.query('COMMIT');

      return res.json({
        success: true,
        message: `${deleted.length} bloqueio(s) processado(s)`,
        data: {
          deleted_blocks: deleted,
          created_fragments: created,
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[ScheduleBlock RELEASE] Erro:', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao liberar horários' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
