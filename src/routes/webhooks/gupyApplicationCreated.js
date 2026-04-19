const express = require('express');
const router = express.Router();
const db = require('../../../db');
const { logEvent } = require('../../services/eventLogService');
const gupyService = require('../../services/gupyService');
const { transformGupyToCvData } = require('../../lib/cvTransformer');
const { upsertFromWebhook } = require('../../services/webhookCandidateService');

function validatePayload(payload) {
  if (!payload || !payload.data) return 'Missing payload or data';
  if (payload.event !== 'application.created') return `Unexpected event: ${payload.event}`;
  if (!payload.data.application?.id) return 'Missing application.id';
  if (!payload.data.candidate?.id) return 'Missing candidate.id';
  if (!payload.data.job?.id) return 'Missing job.id';
  if (!payload.id) return 'Missing event id';
  return null;
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok', webhook: 'application.created' });
});

router.post('/', async (req, res) => {
  try {
    const payload = req.body;

    // 1. Validate
    const validationError = validatePayload(payload);
    if (validationError) {
      console.error('[Webhook application.created] Invalid payload:', validationError);
      return res.status(200).json({ success: true });
    }

    const { data } = payload;
    const realTimestamp = payload.date ? new Date(payload.date) : new Date();

    // 2. Log event (dedup via event_id)
    const { isDuplicate } = await logEvent({
      eventType: 'application.created',
      entityType: 'application',
      entityId: String(data.application.id),
      actorType: 'webhook',
      metadata: {
        jobId: data.job?.id,
        jobName: data.job?.name,
        candidateId: data.candidate?.id,
        initialStepName: data.application.currentStep?.name,
        initialStepId: data.application.currentStep?.id,
      },
      source: 'gupy_webhook',
      eventTimestamp: realTimestamp,
      eventId: payload.id,
    });

    // 3. If duplicate, skip further processing
    if (isDuplicate) {
      console.log(`[Webhook application.created] Duplicate event ${payload.id}, skipping`);
      return res.status(200).json({ success: true });
    }

    // 4. UPSERT candidate + application (if job exists locally, zero API calls)
    const upsertResult = await upsertFromWebhook({
      jobGupyId: data.job.id,
      applicationGupyId: data.application.id,
      candidateData: data.candidate,
      applicationData: data.application,
      webhookTimestamp: realTimestamp,
    });

    if (upsertResult.action === 'skipped') {
      console.log(`[Webhook application.created] Job ${data.job?.id} not found locally, skipping`);
    } else if (upsertResult.action === 'error') {
      console.warn(`[Webhook application.created] UPSERT failed: ${upsertResult.reason}`);
    } else {
      console.log(`[Webhook application.created] UPSERT: candidate=${upsertResult.candidateId}, application=${upsertResult.applicationId}, new=${upsertResult.isNew}`);
    }

    // 5. Best-effort: fetch cv_data from Gupy API v2 (failure does not affect response)
    if (upsertResult.action === 'upserted') {
      try {
        const gupyCandidate = await gupyService.fetchCandidateById(data.candidate.id);
        if (gupyCandidate) {
          const cvData = transformGupyToCvData(gupyCandidate);
          await db.query(`
            UPDATE candidate SET cv_data = $1
            WHERE id_candidate_gupy = $2
          `, [JSON.stringify(cvData), String(data.candidate.id)]);
        }
      } catch (cvError) {
        console.error('[Webhook application.created] Failed to fetch cv_data:', cvError.message);
      }
    }

    console.log(`[Webhook application.created] Processed: application=${data.application.id}, job=${data.job?.name}`);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Webhook application.created] Error:', error.message);
    return res.status(200).json({ success: true });
  }
});

module.exports = router;
