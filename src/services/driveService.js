/**
 * Google Drive Service
 * Handles file uploads to Google Drive using Domain-Wide Delegation.
 * Requires drive.file scope in Domain-Wide Delegation settings.
 * Uses same Service Account credentials as googleCalendar.js.
 *
 * Files are uploaded to the organizer's Drive root folder and made publicly
 * viewable via link sharing. No folder organization is applied.
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const Bottleneck = require('bottleneck');
const { logApiError } = require('../lib/errorLogger');

/**
 * Rate limiters per organizer email.
 * Each email gets its own limiter to avoid cross-user rate limit issues.
 */
const limiters = new Map();

/**
 * Get or create a rate limiter for the given email.
 * Settings: max 5 concurrent, min 200ms between requests.
 *
 * @param {string} email - Organizer email
 * @returns {Bottleneck} Rate limiter instance
 */
function getLimiter(email) {
  if (!limiters.has(email)) {
    limiters.set(email, new Bottleneck({
      maxConcurrent: 5,
      minTime: 200,
      reservoir: 50,
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 10000,
    }));
    console.log(`[DRIVE_SERVICE] Rate limiter created for ${email}`);
  }
  return limiters.get(email);
}

// Load credentials from environment (same as googleCalendar.js)
let credentials;
try {
  const requiredEnvVars = [
    'GOOGLE_SA_TYPE',
    'GOOGLE_SA_PROJECT_ID',
    'GOOGLE_SA_PRIVATE_KEY_ID',
    'GOOGLE_SA_PRIVATE_KEY',
    'GOOGLE_SA_CLIENT_EMAIL',
    'GOOGLE_SA_CLIENT_ID'
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing environment variable: ${envVar}`);
    }
  }

  credentials = {
    type: process.env.GOOGLE_SA_TYPE,
    project_id: process.env.GOOGLE_SA_PROJECT_ID,
    private_key_id: process.env.GOOGLE_SA_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_SA_CLIENT_ID,
  };

  console.log('[DRIVE_SERVICE] Service account credentials loaded successfully');
} catch (error) {
  console.error('[DRIVE_SERVICE] Failed to load service account credentials:', error.message);
  credentials = null;
}

/**
 * Get authenticated Drive client with impersonation
 * @param {string} userEmail - Email to impersonate (organizer's email)
 * @returns {Promise<drive_v3.Drive>}
 */
async function getDriveClient(userEmail) {
  if (!credentials) {
    throw new Error('Google Service Account credentials not loaded');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const client = await auth.getClient();
  client.subject = userEmail; // Domain-Wide Delegation impersonation

  return google.drive({ version: 'v3', auth: client });
}

/**
 * Upload CV PDF to Google Drive
 * File is created in the organizer's Drive and shared with "anyone with link can view"
 *
 * @param {Buffer} buffer - PDF file buffer
 * @param {string} filename - Filename for the PDF
 * @param {string} organizerEmail - Email of the organizer (for Drive ownership)
 * @param {Object} [context={}] - Additional context for error logging
 * @param {number} [context.candidateId] - Candidate ID for error tracking
 * @returns {Promise<{fileId: string, webViewLink: string}>}
 * @throws {Error} When Service Account credentials are not loaded
 * @throws {Error} When Drive API call fails (quota exceeded, permission denied, etc.)
 */
async function uploadCvPdf(buffer, filename, organizerEmail, context = {}) {
  console.log(`[DRIVE_SERVICE] Uploading ${filename} to Drive for ${organizerEmail}...`);

  const limiter = getLimiter(organizerEmail);

  try {
    const drive = await getDriveClient(organizerEmail);

    // Create file in Drive (rate limited)
    const fileMetadata = {
      name: filename,
      mimeType: 'application/pdf',
    };

    const media = {
      mimeType: 'application/pdf',
      body: Readable.from(buffer),
    };

    const file = await limiter.schedule(() =>
      drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, webViewLink',
      })
    );

    const fileId = file.data.id;

    // Set permission: anyone with link can view (rate limited)
    await limiter.schedule(() =>
      drive.permissions.create({
        fileId: fileId,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      })
    );

    console.log(`[DRIVE_SERVICE] File uploaded: ${fileId}`);

    return {
      fileId: fileId,
      webViewLink: file.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
    };
  } catch (error) {
    // Log to database for tracking and monitoring
    await logApiError('google_drive', 'uploadCvPdf', error, {
      body: { filename, organizerEmail, candidateId: context.candidateId },
    });
    throw error; // Re-throw to let caller handle
  }
}

module.exports = {
  uploadCvPdf,
  getDriveClient,
};
