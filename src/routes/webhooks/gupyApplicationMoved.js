const express = require('express');
const router = express.Router();
const db = require('../../../db');
const { logEvent } = require('../../services/eventLogService');
const { upsertFromWebhook, normalizeStatus } = require('../../services/webhookCandidateService');

function validatePayload(payload) {
  if (!payload || !payload.data) return 'Missing payload or data';
  if (payload.event !== 'application.moved') return `Unexpected event: ${payload.event}`;
  if (!payload.data.application?.id) return 'Missing application.id';
  if (!payload.data.application?.currentStep) return 'Missing currentStep';
  if (!payload.id) return 'Missing event id';
  return null;
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok', webhook: 'application.moved' });
});

router.post('/', async (req, res) => {
  try {
    const payload = req.body;

    // 1. Validate
    const validationError = validatePayload(payload);
    if (validationError) {
      console.error('[Webhook application.moved] Invalid payload:', validationError);
      return res.status(200).json({ success: true });
    }

    const { data } = payload;
    const realTimestamp = payload.date ? new Date(payload.date) : new Date();

    // 2. Log event (dedup via event_id)
    const { isDuplicate } = await logEvent({
      eventType: 'application.moved',
      entityType: 'application',
      entityId: String(data.application.id),
      actorType: 'webhook',
      actorId: data.user?.id?.toString() || null,
      actorName: data.user?.name || null,
      actorEmail: data.user?.email || null,
      metadata: {
        jobId: data.job?.id,
        jobName: data.job?.name,
        candidateId: data.candidate?.id,
        previousStepId: data.application.previousStep?.id,
        previousStepName: data.application.previousStep?.name,
        currentStepId: data.application.currentStep.id,
        currentStepName: data.application.currentStep.name,
      },
      source: 'gupy_webhook',
      eventTimestamp: realTimestamp,
      eventId: payload.id,
    });

    // 3. Skip if duplicate
    if (isDuplicate) {
      console.log(`[Webhook application.moved] Duplicate event ${payload.id}, skipping`);
      return res.status(200).json({ success: true });
    }

    // 4. Try UPDATE first (fast path — zero API calls)
    const updateResult = await db.query(`
      UPDATE application SET
        current_step_id = $1,
        current_step_name = $2,
        status_application = COALESCE($3, status_application),
        tags = COALESCE($4, tags),
        step_updated_at = $5
      WHERE id_application_gupy = $6
    `, [
      data.application.currentStep.id,
      data.application.currentStep.name,
      normalizeStatus(data.application.status),
      data.application.tags ? JSON.stringify(data.application.tags) : null,
      realTimestamp,
      String(data.application.id),
    ]);

    if (updateResult.rowCount > 0) {
      console.log(`[Webhook application.moved] Processed: app=${data.application.id}, ${data.application.previousStep?.name} → ${data.application.currentStep.name}`);
      return res.status(200).json({ success: true });
    }

    // 5. Application not found locally — fallback UPSERT (requires candidate_id in payload)
    if (!data.candidate?.id || !data.job?.id) {
      console.warn(`[Webhook application.moved] Application ${data.application.id} not found locally, missing candidate/job for UPSERT`);
      return res.status(200).json({ success: true });
    }

    const upsertResult = await upsertFromWebhook({
      jobGupyId: data.job.id,
      applicationGupyId: data.application.id,
      candidateData: data.candidate,
      applicationData: data.application,
      webhookTimestamp: realTimestamp,
    });

    if (upsertResult.action === 'skipped') {
      console.log(`[Webhook application.moved] Job ${data.job.id} not found locally, skipping`);
    } else if (upsertResult.action === 'error') {
      console.warn(`[Webhook application.moved] UPSERT failed: ${upsertResult.reason}`);
    } else {
      console.log(`[Webhook application.moved] UPSERT (missed created): candidate=${upsertResult.candidateId}, application=${upsertResult.applicationId}`);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Webhook application.moved] Error:', error.message);
    return res.status(200).json({ success: true });
  }
});

module.exports = router;
