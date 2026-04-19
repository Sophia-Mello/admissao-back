const { google } = require('googleapis');
const Bottleneck = require('bottleneck');
const { logApiError } = require('./errorLogger');

/**
 * Rate limiters per organizer email.
 * Each email gets its own limiter to avoid cross-user rate limit issues.
 * Google Calendar API limit: ~100 requests/second per user, but we're conservative.
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
      maxConcurrent: 5,      // Max 5 concurrent requests
      minTime: 200,          // Min 200ms between requests (5 req/sec max)
      reservoir: 50,         // Initial burst capacity
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 10000, // Refill every 10 seconds
    }));
    console.log(`[GOOGLE_CALENDAR] Rate limiter created for ${email}`);
  }
  return limiters.get(email);
}

/**
 * Google Calendar API wrapper with Domain-Wide Delegation support.
 *
 * Allows creating/deleting events in unit calendars by impersonating
 * the unit's email address using a Service Account.
 *
 * Environment variables required:
 * - GOOGLE_SA_TYPE: Service account type (service_account)
 * - GOOGLE_SA_PROJECT_ID: Google Cloud project ID
 * - GOOGLE_SA_PRIVATE_KEY_ID: Private key ID
 * - GOOGLE_SA_PRIVATE_KEY: Private key (with \n for newlines)
 * - GOOGLE_SA_CLIENT_EMAIL: Service account email
 * - GOOGLE_SA_CLIENT_ID: Client ID
 * - GOOGLE_CALENDAR_TIMEZONE: Timezone (default: America/Sao_Paulo)
 */

// Load Service Account credentials from environment variables
let credentials;
try {
  // Build credentials object from environment variables
  const requiredEnvVars = [
    'GOOGLE_SA_TYPE',
    'GOOGLE_SA_PROJECT_ID',
    'GOOGLE_SA_PRIVATE_KEY_ID',
    'GOOGLE_SA_PRIVATE_KEY',
    'GOOGLE_SA_CLIENT_EMAIL',
    'GOOGLE_SA_CLIENT_ID'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  credentials = {
    type: process.env.GOOGLE_SA_TYPE,
    project_id: process.env.GOOGLE_SA_PROJECT_ID,
    private_key_id: process.env.GOOGLE_SA_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n'), // Decode newlines
    client_email: process.env.GOOGLE_SA_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_SA_CLIENT_ID,
    auth_uri: process.env.GOOGLE_SA_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
    token_uri: process.env.GOOGLE_SA_TOKEN_URI || 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: process.env.GOOGLE_SA_AUTH_PROVIDER_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.GOOGLE_SA_CLIENT_CERT_URL,
    universe_domain: process.env.GOOGLE_SA_UNIVERSE_DOMAIN || 'googleapis.com'
  };

  console.log('[GOOGLE_CALENDAR] Service account credentials loaded successfully from environment variables');
} catch (error) {
  console.error('[GOOGLE_CALENDAR] Failed to load service account credentials:', error.message);
  credentials = null;
}

/**
 * Get authenticated Google Calendar client with impersonation
 * @param {string} unidadeEmail - Email to impersonate (e.g., escola@tomeducacao.com.br)
 * @returns {Promise<object>} Google Calendar API client
 */
async function getCalendarClient(unidadeEmail) {
  if (!credentials) {
    throw new Error('Google Service Account credentials not loaded');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  const authClient = await auth.getClient();

  // Domain-Wide Delegation: impersonate the unit's email
  authClient.subject = unidadeEmail;

  return google.calendar({ version: 'v3', auth: authClient });
}

/**
 * Create event in Google Calendar with retry logic for rate limits
 *
 * @param {string} unidadeEmail - Email of the unit calendar
 * @param {object} eventData - Event data
 * @param {string} eventData.summary - Event title
 * @param {string} eventData.description - Event description (supports markdown)
 * @param {string} eventData.location - Event location
 * @param {string} eventData.start - ISO 8601 datetime with timezone
 * @param {string} eventData.end - ISO 8601 datetime with timezone
 * @param {Array<{email: string, displayName: string}>} eventData.attendees - Attendees
 * @param {object} eventData.privateProps - Private extended properties
 * @param {object} context - Context for error logging
 * @param {number} context.id_booking - Related booking ID
 * @param {number} context.id_unidade - Related unidade ID
 * @param {number} retries - Number of retries remaining (default: 3)
 * @returns {Promise<object>} Created event with id, htmlLink, etc.
 */
async function createEvent(unidadeEmail, eventData, context = {}, retries = 3) {
  // Validate required fields
  if (!eventData.summary || !eventData.start || !eventData.end) {
    throw new Error('Campos obrigatórios faltando: summary, start, end');
  }

  // Get rate limiter for this organizer
  const limiter = getLimiter(unidadeEmail);

  try {
    const calendar = await getCalendarClient(unidadeEmail);

    const event = {
      summary: eventData.summary,
      description: eventData.description,
      location: eventData.location,
      start: {
        dateTime: eventData.start,
        timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
      end: {
        dateTime: eventData.end,
        timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
      attendees: eventData.attendees || [],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 60 },      // 1 hour before
        ],
      },
    };

    // Add private extended properties if provided
    if (eventData.privateProps) {
      event.extendedProperties = {
        private: eventData.privateProps,
      };
    }

    // Use rate limiter to schedule the API call
    const response = await limiter.schedule(() => calendar.events.insert({
      calendarId: unidadeEmail,
      resource: event,
      sendUpdates: 'all', // Send email invitations
    }));

    console.log(`[GOOGLE_CALENDAR] Event created: ${response.data.id} for ${unidadeEmail}`);
    return response.data;

  } catch (error) {
    // Handle rate limiting with exponential backoff
    if (error.code === 429 && retries > 0) {
      const delay = Math.pow(2, 3 - retries) * 1000; // 1s, 2s, 4s
      console.log(`[GOOGLE_CALENDAR] Rate limited. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return createEvent(unidadeEmail, eventData, context, retries - 1);
    }

    // Log error to database
    await logApiError('google_calendar', 'createEvent', error, {
      url: unidadeEmail,
      body: { summary: eventData.summary, start: eventData.start, end: eventData.end },
      id_booking: context.id_booking,
      id_unidade: context.id_unidade,
    });

    // Handle specific errors
    if (error.code === 401 || error.code === 403) {
      throw new Error(`Permissões insuficientes. Verifique Domain-Wide Delegation para ${unidadeEmail}.`);
    }
    if (error.code === 404) {
      throw new Error(`Calendário ${unidadeEmail} não encontrado.`);
    }

    console.error('[GOOGLE_CALENDAR] Error creating event:', error.message);
    throw new Error(`Erro ao criar evento no Google Calendar: ${error.message}`);
  }
}

/**
 * Update event in Google Calendar
 *
 * @param {string} unidadeEmail - Email of the unit calendar
 * @param {string} eventId - Google Calendar event ID
 * @param {object} eventData - Event data to update (partial update)
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} Updated event data
 */
async function updateEvent(unidadeEmail, eventId, eventData, context = {}) {
  try {
    const calendar = await getCalendarClient(unidadeEmail);

    // Fetch existing event first
    const existingEvent = await calendar.events.get({
      calendarId: unidadeEmail,
      eventId: eventId,
    });

    // Merge with new data (partial update)
    const updatedEvent = {
      ...existingEvent.data,
      ...eventData,
    };

    const response = await calendar.events.update({
      calendarId: unidadeEmail,
      eventId: eventId,
      resource: updatedEvent,
      sendUpdates: 'all', // Notify attendees
    });

    console.log(`[GOOGLE_CALENDAR] Event updated: ${eventId} for ${unidadeEmail}`);
    return response.data;

  } catch (error) {
    // Log error to database
    await logApiError('google_calendar', 'updateEvent', error, {
      url: `${unidadeEmail}/${eventId}`,
      body: eventData,
      id_booking: context.id_booking,
      id_unidade: context.id_unidade,
    });

    if (error.code === 404) {
      throw new Error(`Evento ${eventId} não encontrado no calendário ${unidadeEmail}.`);
    }

    console.error('[GOOGLE_CALENDAR] Error updating event:', error.message);
    throw new Error(`Erro ao atualizar evento do Google Calendar: ${error.message}`);
  }
}

/**
 * Create event in a SPECIFIC Google Calendar WITH Google Meet link
 *
 * Use this when you need to create events in a shared calendar (not the organizer's primary).
 * The organizer impersonates via Domain-Wide Delegation but creates in a different calendar.
 *
 * Meet settings:
 * - Recording: Enabled via Google Workspace Admin Console (org-level setting)
 * - Waiting room: Guests must wait until host admits (org-level setting)
 * - Restricted access: Only invited attendees can join (guestsCanInviteOthers: false)
 *
 * @param {string} organizerEmail - Email to impersonate (e.g., recrutamento@tomeducacao.com.br)
 * @param {string} calendarId - Calendar ID to create event in (can be email or group calendar ID)
 * @param {object} eventData - Event data
 * @param {string} eventData.summary - Event title
 * @param {string} eventData.description - Event description
 * @param {string} eventData.start - ISO 8601 datetime with timezone
 * @param {string} eventData.end - ISO 8601 datetime with timezone
 * @param {object} context - Context for error logging
 * @param {number} retries - Number of retries remaining (default: 3)
 * @returns {Promise<object>} Created event with id, htmlLink, meetLink, etc.
 */
async function createEventInCalendar(organizerEmail, calendarId, eventData, context = {}, retries = 3) {
  // Validate required fields
  if (!eventData.summary || !eventData.start || !eventData.end) {
    throw new Error('Campos obrigatórios faltando: summary, start, end');
  }

  // Get rate limiter for this organizer
  const limiter = getLimiter(organizerEmail);

  try {
    const calendar = await getCalendarClient(organizerEmail);

    const event = {
      summary: eventData.summary,
      description: eventData.description,
      location: eventData.location,
      start: {
        dateTime: eventData.start,
        timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
      end: {
        dateTime: eventData.end,
        timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
      // Include attendees (for booking events - candidate receives invite)
      attendees: eventData.attendees || [],
      // Support for Drive attachments (CV PDFs)
      attachments: eventData.attachments || [],
      // Security settings
      guestsCanInviteOthers: false,  // Only host can invite others
      guestsCanModify: false,         // Guests cannot modify event
      guestsCanSeeOtherGuests: false, // Guests cannot see other attendees
      visibility: 'private',          // Private event
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 60 },      // 1 hour before
        ],
      },
    };

    // Only add Google Meet link if not explicitly skipped (e.g., aula teste doesn't need Meet)
    if (!eventData.skipConference) {
      event.conferenceData = {
        createRequest: {
          requestId: `evento_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      };
    }

    // Add private extended properties if provided
    if (eventData.privateProps) {
      event.extendedProperties = {
        private: eventData.privateProps,
      };
    }

    // Use rate limiter to schedule the API call
    // sendUpdates: 'all' to send email invites to attendees
    // conferenceDataVersion: 1 only needed when creating Meet link
    const response = await limiter.schedule(() => calendar.events.insert({
      calendarId: calendarId, // Use specific calendar, not organizer's primary
      resource: event,
      conferenceDataVersion: eventData.skipConference ? 0 : 1,
      sendUpdates: 'all', // Send email invitations to attendees
      supportsAttachments: true, // Enable Drive file attachments
    }));

    // Extract Meet link from response
    const meetLink = response.data.conferenceData?.entryPoints?.find(
      (ep) => ep.entryPointType === 'video'
    )?.uri;

    console.log(`[GOOGLE_CALENDAR] Event created in ${calendarId}: ${response.data.id}`);
    console.log(`[GOOGLE_CALENDAR] Meet link: ${meetLink}`);

    return {
      ...response.data,
      meetLink: meetLink || null,
    };

  } catch (error) {
    // Handle rate limiting with exponential backoff
    if (error.code === 429 && retries > 0) {
      const delay = Math.pow(2, 3 - retries) * 1000;
      console.log(`[GOOGLE_CALENDAR] Rate limited. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return createEventInCalendar(organizerEmail, calendarId, eventData, context, retries - 1);
    }

    // Log error to database
    await logApiError('google_calendar', 'createEventInCalendar', error, {
      url: calendarId,
      body: { summary: eventData.summary, start: eventData.start, end: eventData.end },
      ...context,
    });

    // Handle specific errors
    if (error.code === 401 || error.code === 403) {
      throw new Error(`Permissões insuficientes para ${organizerEmail} acessar ${calendarId}.`);
    }
    if (error.code === 404) {
      throw new Error(`Calendário ${calendarId} não encontrado.`);
    }

    console.error('[GOOGLE_CALENDAR] Error creating event in calendar:', error.message);
    throw new Error(`Erro ao criar evento no Google Calendar: ${error.message}`);
  }
}

/**
 * Delete event from a SPECIFIC Google Calendar
 *
 * @param {string} organizerEmail - Email to impersonate
 * @param {string} calendarId - Calendar ID where event exists
 * @param {string} eventId - Google Calendar event ID
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} { success: true }
 */
async function deleteEventFromCalendar(organizerEmail, calendarId, eventId, context = {}) {
  // Get rate limiter for this organizer
  const limiter = getLimiter(organizerEmail);

  try {
    const calendar = await getCalendarClient(organizerEmail);

    // Use rate limiter to schedule the API call
    await limiter.schedule(() => calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
      sendUpdates: 'all',
    }));

    console.log(`[GOOGLE_CALENDAR] Event deleted: ${eventId} from ${calendarId}`);
    return { success: true };

  } catch (error) {
    // If event already deleted (404), consider it success
    if (error.code === 404) {
      console.log(`[GOOGLE_CALENDAR] Event ${eventId} already deleted (404)`);
      return { success: true };
    }

    // Log error to database
    await logApiError('google_calendar', 'deleteEventFromCalendar', error, {
      url: `${calendarId}/${eventId}`,
      ...context,
    });

    console.error('[GOOGLE_CALENDAR] Error deleting event from calendar:', error.message);
    throw new Error(`Erro ao deletar evento do Google Calendar: ${error.message}`);
  }
}

/**
 * Create event in Google Calendar WITH Google Meet link
 *
 * Meet settings:
 * - Recording: Enabled via Google Workspace Admin Console (org-level setting)
 * - Waiting room: Guests must wait until host admits (org-level setting)
 * - Restricted access: Only invited attendees can join (guestsCanInviteOthers: false)
 *
 * @param {string} unidadeEmail - Email of the unit calendar (organizer)
 * @param {object} eventData - Event data
 * @param {string} eventData.summary - Event title
 * @param {string} eventData.description - Event description
 * @param {string} eventData.start - ISO 8601 datetime with timezone
 * @param {string} eventData.end - ISO 8601 datetime with timezone
 * @param {object} context - Context for error logging
 * @param {number} retries - Number of retries remaining (default: 3)
 * @returns {Promise<object>} Created event with id, htmlLink, meetLink, etc.
 */
async function createEventWithMeet(unidadeEmail, eventData, context = {}, retries = 3) {
  // Validate required fields
  if (!eventData.summary || !eventData.start || !eventData.end) {
    throw new Error('Campos obrigatórios faltando: summary, start, end');
  }

  try {
    const calendar = await getCalendarClient(unidadeEmail);

    const event = {
      summary: eventData.summary,
      description: eventData.description,
      start: {
        dateTime: eventData.start,
        timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
      end: {
        dateTime: eventData.end,
        timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
      // Request automatic Meet link generation
      conferenceData: {
        createRequest: {
          requestId: `evento_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      },
      // Security settings
      guestsCanInviteOthers: false,  // Only host can invite others
      guestsCanModify: false,         // Guests cannot modify event
      guestsCanSeeOtherGuests: false, // Guests cannot see other attendees
      visibility: 'private',          // Private event
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 60 },      // 1 hour before
        ],
      },
    };

    // Add private extended properties if provided
    if (eventData.privateProps) {
      event.extendedProperties = {
        private: eventData.privateProps,
      };
    }

    const response = await calendar.events.insert({
      calendarId: unidadeEmail,
      resource: event,
      conferenceDataVersion: 1, // Required to create Meet link
      sendUpdates: 'none', // Don't send invites yet (we'll add attendees later)
    });

    // Extract Meet link from response
    const meetLink = response.data.conferenceData?.entryPoints?.find(
      (ep) => ep.entryPointType === 'video'
    )?.uri;

    console.log(`[GOOGLE_CALENDAR] Event created with Meet: ${response.data.id} for ${unidadeEmail}`);
    console.log(`[GOOGLE_CALENDAR] Meet link: ${meetLink}`);

    return {
      ...response.data,
      meetLink: meetLink || null,
    };

  } catch (error) {
    // Handle rate limiting with exponential backoff
    if (error.code === 429 && retries > 0) {
      const delay = Math.pow(2, 3 - retries) * 1000; // 1s, 2s, 4s
      console.log(`[GOOGLE_CALENDAR] Rate limited. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return createEventWithMeet(unidadeEmail, eventData, context, retries - 1);
    }

    // Log error to database
    await logApiError('google_calendar', 'createEventWithMeet', error, {
      url: unidadeEmail,
      body: { summary: eventData.summary, start: eventData.start, end: eventData.end },
      ...context,
    });

    // Handle specific errors
    if (error.code === 401 || error.code === 403) {
      throw new Error(`Permissões insuficientes. Verifique Domain-Wide Delegation para ${unidadeEmail}.`);
    }
    if (error.code === 404) {
      throw new Error(`Calendário ${unidadeEmail} não encontrado.`);
    }

    console.error('[GOOGLE_CALENDAR] Error creating event with Meet:', error.message);
    throw new Error(`Erro ao criar evento com Meet no Google Calendar: ${error.message}`);
  }
}

/**
 * Add attendee to an existing Google Calendar event
 *
 * @param {string} unidadeEmail - Email of the unit calendar
 * @param {string} eventId - Google Calendar event ID
 * @param {object} attendee - Attendee data
 * @param {string} attendee.email - Attendee email
 * @param {string} [attendee.displayName] - Attendee display name
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} Updated event data
 */
async function addAttendee(unidadeEmail, eventId, attendee, context = {}) {
  try {
    const calendar = await getCalendarClient(unidadeEmail);

    // Fetch existing event first
    const existingEvent = await calendar.events.get({
      calendarId: unidadeEmail,
      eventId: eventId,
    });

    // Add new attendee to existing list
    const currentAttendees = existingEvent.data.attendees || [];
    const newAttendees = [
      ...currentAttendees,
      {
        email: attendee.email,
        displayName: attendee.displayName || attendee.email,
        responseStatus: 'needsAction',
      },
    ];

    const response = await calendar.events.patch({
      calendarId: unidadeEmail,
      eventId: eventId,
      resource: {
        attendees: newAttendees,
      },
      sendUpdates: 'all', // Send invitation email
    });

    console.log(`[GOOGLE_CALENDAR] Attendee ${attendee.email} added to event ${eventId}`);
    return response.data;

  } catch (error) {
    await logApiError('google_calendar', 'addAttendee', error, {
      url: `${unidadeEmail}/${eventId}`,
      body: attendee,
      ...context,
    });

    if (error.code === 404) {
      throw new Error(`Evento ${eventId} não encontrado no calendário ${unidadeEmail}.`);
    }

    console.error('[GOOGLE_CALENDAR] Error adding attendee:', error.message);
    throw new Error(`Erro ao adicionar participante: ${error.message}`);
  }
}

/**
 * Add attendee to event in a SPECIFIC Google Calendar
 *
 * @param {string} organizerEmail - Email to impersonate
 * @param {string} calendarId - Calendar ID where event exists
 * @param {string} eventId - Google Calendar event ID
 * @param {object} attendee - Attendee data
 * @param {string} attendee.email - Attendee email
 * @param {string} [attendee.displayName] - Attendee display name
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} Updated event data
 */
async function addAttendeeToCalendar(organizerEmail, calendarId, eventId, attendee, context = {}) {
  try {
    const calendar = await getCalendarClient(organizerEmail);

    // Fetch existing event first
    const existingEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: eventId,
    });

    // Add new attendee to existing list
    const currentAttendees = existingEvent.data.attendees || [];
    const newAttendees = [
      ...currentAttendees,
      {
        email: attendee.email,
        displayName: attendee.displayName || attendee.email,
        responseStatus: 'needsAction',
      },
    ];

    const response = await calendar.events.patch({
      calendarId: calendarId,
      eventId: eventId,
      resource: {
        attendees: newAttendees,
      },
      sendUpdates: 'all', // Send invitation email
    });

    console.log(`[GOOGLE_CALENDAR] Attendee ${attendee.email} added to event ${eventId} in ${calendarId}`);
    return response.data;

  } catch (error) {
    await logApiError('google_calendar', 'addAttendeeToCalendar', error, {
      url: `${calendarId}/${eventId}`,
      body: attendee,
      ...context,
    });

    if (error.code === 404) {
      throw new Error(`Evento ${eventId} não encontrado no calendário ${calendarId}.`);
    }

    console.error('[GOOGLE_CALENDAR] Error adding attendee to calendar:', error.message);
    throw new Error(`Erro ao adicionar participante: ${error.message}`);
  }
}

/**
 * Remove attendee from an existing Google Calendar event
 *
 * @param {string} unidadeEmail - Email of the unit calendar
 * @param {string} eventId - Google Calendar event ID
 * @param {string} attendeeEmail - Email of attendee to remove
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} Updated event data
 */
async function removeAttendee(unidadeEmail, eventId, attendeeEmail, context = {}) {
  try {
    const calendar = await getCalendarClient(unidadeEmail);

    // Fetch existing event first
    const existingEvent = await calendar.events.get({
      calendarId: unidadeEmail,
      eventId: eventId,
    });

    // Remove attendee from list
    const currentAttendees = existingEvent.data.attendees || [];
    const newAttendees = currentAttendees.filter(
      (a) => a.email.toLowerCase() !== attendeeEmail.toLowerCase()
    );

    const response = await calendar.events.patch({
      calendarId: unidadeEmail,
      eventId: eventId,
      resource: {
        attendees: newAttendees,
      },
      sendUpdates: 'all', // Notify about removal
    });

    console.log(`[GOOGLE_CALENDAR] Attendee ${attendeeEmail} removed from event ${eventId}`);
    return response.data;

  } catch (error) {
    await logApiError('google_calendar', 'removeAttendee', error, {
      url: `${unidadeEmail}/${eventId}`,
      body: { attendeeEmail },
      ...context,
    });

    if (error.code === 404) {
      throw new Error(`Evento ${eventId} não encontrado no calendário ${unidadeEmail}.`);
    }

    console.error('[GOOGLE_CALENDAR] Error removing attendee:', error.message);
    throw new Error(`Erro ao remover participante: ${error.message}`);
  }
}

/**
 * Remove attendee from event in a SPECIFIC Google Calendar
 *
 * @param {string} organizerEmail - Email to impersonate
 * @param {string} calendarId - Calendar ID where event exists
 * @param {string} eventId - Google Calendar event ID
 * @param {string} attendeeEmail - Email of attendee to remove
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} Updated event data
 */
async function removeAttendeeFromCalendar(organizerEmail, calendarId, eventId, attendeeEmail, context = {}) {
  try {
    const calendar = await getCalendarClient(organizerEmail);

    // Fetch existing event first
    const existingEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: eventId,
    });

    // Remove attendee from list
    const currentAttendees = existingEvent.data.attendees || [];
    const newAttendees = currentAttendees.filter(
      (a) => a.email.toLowerCase() !== attendeeEmail.toLowerCase()
    );

    const response = await calendar.events.patch({
      calendarId: calendarId,
      eventId: eventId,
      resource: {
        attendees: newAttendees,
      },
      sendUpdates: 'all', // Notify about removal
    });

    console.log(`[GOOGLE_CALENDAR] Attendee ${attendeeEmail} removed from event ${eventId} in ${calendarId}`);
    return response.data;

  } catch (error) {
    await logApiError('google_calendar', 'removeAttendeeFromCalendar', error, {
      url: `${calendarId}/${eventId}`,
      body: { attendeeEmail },
      ...context,
    });

    if (error.code === 404) {
      throw new Error(`Evento ${eventId} não encontrado no calendário ${calendarId}.`);
    }

    console.error('[GOOGLE_CALENDAR] Error removing attendee from calendar:', error.message);
    throw new Error(`Erro ao remover participante: ${error.message}`);
  }
}

/**
 * Delete event from Google Calendar
 *
 * @param {string} unidadeEmail - Email of the unit calendar
 * @param {string} eventId - Google Calendar event ID
 * @param {object} context - Context for error logging
 * @returns {Promise<object>} { success: true }
 */
async function deleteEvent(unidadeEmail, eventId, context = {}) {
  // Get rate limiter for this organizer
  const limiter = getLimiter(unidadeEmail);

  try {
    const calendar = await getCalendarClient(unidadeEmail);

    // Use rate limiter to schedule the API call
    await limiter.schedule(() => calendar.events.delete({
      calendarId: unidadeEmail,
      eventId: eventId,
      sendUpdates: 'all', // Notify attendees
    }));

    console.log(`[GOOGLE_CALENDAR] Event deleted: ${eventId} from ${unidadeEmail}`);
    return { success: true };

  } catch (error) {
    // If event already deleted (404), consider it success
    if (error.code === 404) {
      console.log(`[GOOGLE_CALENDAR] Event ${eventId} already deleted (404)`);
      return { success: true };
    }

    // Log error to database
    await logApiError('google_calendar', 'deleteEvent', error, {
      url: `${unidadeEmail}/${eventId}`,
      id_booking: context.id_booking,
      id_unidade: context.id_unidade,
    });

    console.error('[GOOGLE_CALENDAR] Error deleting event:', error.message);
    throw new Error(`Erro ao deletar evento do Google Calendar: ${error.message}`);
  }
}

/**
 * Create a secondary calendar (for setup scripts)
 *
 * Creates a new calendar owned by the impersonated user.
 * Use this to create unit-specific calendars during initial setup.
 *
 * @param {string} ownerEmail - Email to impersonate (calendar owner)
 * @param {string} calendarName - Name/summary of the calendar
 * @param {object} options - Optional settings
 * @param {string} options.description - Calendar description
 * @param {string} options.timeZone - Timezone (default: America/Sao_Paulo)
 * @returns {Promise<object>} Created calendar with id, summary, etc.
 */
async function createCalendar(ownerEmail, calendarName, options = {}) {
  const limiter = getLimiter(ownerEmail);

  try {
    const calendar = await getCalendarClient(ownerEmail);

    const response = await limiter.schedule(() => calendar.calendars.insert({
      resource: {
        summary: calendarName,
        description: options.description || '',
        timeZone: options.timeZone || process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Sao_Paulo',
      },
    }));

    console.log(`[GOOGLE_CALENDAR] Calendar created: ${response.data.id} (${calendarName})`);
    return response.data;

  } catch (error) {
    await logApiError('google_calendar', 'createCalendar', error, {
      url: ownerEmail,
      body: { summary: calendarName },
    });

    console.error('[GOOGLE_CALENDAR] Error creating calendar:', error.message);
    throw new Error(`Erro ao criar calendário: ${error.message}`);
  }
}

/**
 * Insert ACL rule to grant access to a calendar
 *
 * Creates an access control rule to share a calendar with a user.
 *
 * @param {string} ownerEmail - Email to impersonate (calendar owner)
 * @param {string} calendarId - Calendar ID to share
 * @param {string} userEmail - Email of user to grant access
 * @param {string} role - Access role: 'reader', 'writer', 'owner', 'freeBusyReader'
 * @param {boolean} sendNotifications - Send email notification (default: false)
 * @returns {Promise<object>} Created ACL rule
 */
async function insertAcl(ownerEmail, calendarId, userEmail, role = 'writer', sendNotifications = false) {
  const limiter = getLimiter(ownerEmail);

  try {
    const calendar = await getCalendarClient(ownerEmail);

    const response = await limiter.schedule(() => calendar.acl.insert({
      calendarId: calendarId,
      sendNotifications: sendNotifications,
      resource: {
        role: role,
        scope: {
          type: 'user',
          value: userEmail,
        },
      },
    }));

    console.log(`[GOOGLE_CALENDAR] ACL created: ${userEmail} as ${role} on ${calendarId}`);
    return response.data;

  } catch (error) {
    // If ACL already exists, try to update instead
    if (error.code === 409) {
      console.log(`[GOOGLE_CALENDAR] ACL already exists for ${userEmail}, skipping...`);
      return { id: `user:${userEmail}`, role, scope: { type: 'user', value: userEmail } };
    }

    await logApiError('google_calendar', 'insertAcl', error, {
      url: calendarId,
      body: { userEmail, role },
    });

    console.error('[GOOGLE_CALENDAR] Error inserting ACL:', error.message);
    throw new Error(`Erro ao criar permissão ACL: ${error.message}`);
  }
}

/**
 * Insert calendar into user's calendar list with custom display name
 *
 * Adds an existing calendar to a user's calendar list, allowing them to
 * see and interact with it. Uses summaryOverride to set a custom name.
 *
 * @param {string} userEmail - Email to impersonate (user who will see the calendar)
 * @param {string} calendarId - Calendar ID to add
 * @param {string} summaryOverride - Custom name to display for this user
 * @param {object} options - Optional settings
 * @param {string} options.backgroundColor - Background color (hex, e.g., '#0088aa')
 * @param {string} options.foregroundColor - Foreground color (hex)
 * @param {boolean} options.selected - Show in calendar UI (default: true)
 * @returns {Promise<object>} CalendarList entry
 */
async function insertCalendarList(userEmail, calendarId, summaryOverride, options = {}) {
  const limiter = getLimiter(userEmail);

  try {
    const calendar = await getCalendarClient(userEmail);

    const resource = {
      id: calendarId,
      summaryOverride: summaryOverride,
      selected: options.selected !== false, // default true
    };

    // Add colors if provided (requires colorRgbFormat=true)
    if (options.backgroundColor) {
      resource.backgroundColor = options.backgroundColor;
    }
    if (options.foregroundColor) {
      resource.foregroundColor = options.foregroundColor;
    }

    const response = await limiter.schedule(() => calendar.calendarList.insert({
      resource: resource,
      colorRgbFormat: !!(options.backgroundColor || options.foregroundColor),
    }));

    console.log(`[GOOGLE_CALENDAR] CalendarList entry created: ${calendarId} for ${userEmail} as "${summaryOverride}"`);
    return response.data;

  } catch (error) {
    // If calendar already in list, consider it success
    if (error.code === 409) {
      console.log(`[GOOGLE_CALENDAR] Calendar ${calendarId} already in list for ${userEmail}, skipping...`);
      return { id: calendarId, summaryOverride };
    }

    await logApiError('google_calendar', 'insertCalendarList', error, {
      url: userEmail,
      body: { calendarId, summaryOverride },
    });

    console.error('[GOOGLE_CALENDAR] Error inserting calendar list entry:', error.message);
    throw new Error(`Erro ao adicionar calendário à lista: ${error.message}`);
  }
}

/**
 * Delete a secondary calendar
 *
 * Permanently deletes a calendar. Use with caution - this cannot be undone.
 *
 * @param {string} ownerEmail - Email to impersonate (calendar owner)
 * @param {string} calendarId - Calendar ID to delete
 * @returns {Promise<object>} { success: true }
 */
async function deleteCalendar(ownerEmail, calendarId) {
  const limiter = getLimiter(ownerEmail);

  try {
    const calendar = await getCalendarClient(ownerEmail);

    await limiter.schedule(() => calendar.calendars.delete({
      calendarId: calendarId,
    }));

    console.log(`[GOOGLE_CALENDAR] Calendar deleted: ${calendarId}`);
    return { success: true };

  } catch (error) {
    if (error.code === 404) {
      console.log(`[GOOGLE_CALENDAR] Calendar ${calendarId} already deleted (404)`);
      return { success: true };
    }

    await logApiError('google_calendar', 'deleteCalendar', error, {
      url: calendarId,
    });

    console.error('[GOOGLE_CALENDAR] Error deleting calendar:', error.message);
    throw new Error(`Erro ao deletar calendário: ${error.message}`);
  }
}

module.exports = {
  createEvent,
  updateEvent,
  deleteEvent,
  createEventWithMeet,
  createEventInCalendar,
  deleteEventFromCalendar,
  addAttendee,
  addAttendeeToCalendar,
  removeAttendee,
  removeAttendeeFromCalendar,
  // Calendar management (for setup scripts)
  createCalendar,
  insertAcl,
  insertCalendarList,
  deleteCalendar,
};
