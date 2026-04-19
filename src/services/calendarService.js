const googleCalendar = require('../lib/googleCalendar');
const { generateCvPdf } = require('../lib/cvPdfGenerator');
const { uploadCvPdf } = require('./driveService');
const { getCandidateCv } = require('../lib/cvSync');
const db = require('../../db');

/**
 * Format date for display (DD/MM/YYYY)
 */
function formatDate(isoString) {
  // Extract date from ISO string and format as DD/MM/YYYY
  // WARNING: Database stores timestamps with 'Z' suffix but values represent São Paulo time
  // (due to db.js setting timezone='America/Sao_Paulo'). Don't use Date parsing - it would
  // incorrectly interpret 'Z' as UTC and apply a -3h offset.
  if (!isoString || typeof isoString !== 'string') {
    console.error(`[CalendarService] formatDate: invalid input ${JSON.stringify(isoString)}`);
    return '';
  }
  const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    console.error(`[CalendarService] formatDate: "${isoString}" does not match ISO date pattern`);
    return '';
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Format time for display (HH:MM)
 */
function formatTime(isoString) {
  // Extract time HH:mm from ISO string
  // WARNING: Database stores timestamps with 'Z' suffix but values represent São Paulo time
  // (due to db.js setting timezone='America/Sao_Paulo'). Don't use Date parsing - it would
  // incorrectly interpret 'Z' as UTC and apply a -3h offset.
  if (!isoString || typeof isoString !== 'string') {
    console.error(`[CalendarService] formatTime: invalid input ${JSON.stringify(isoString)}`);
    return '';
  }
  const match = isoString.match(/T(\d{2}):(\d{2})/);
  if (!match) {
    console.error(`[CalendarService] formatTime: "${isoString}" does not contain valid time`);
    return '';
  }
  return `${match[1]}:${match[2]}`;
}

/**
 * Build HTML description for booking event
 */
function buildEventDescription({
  unidade_nome,
  job_name,
  start_at,
  end_at,
  endereco_unidade,
  email_unidade_contato,
  candidate_name,
  candidate_cpf,
  candidate_email,
  candidate_phone,
  rubrica_url,
  candidaturas_validas = []
}) {
  const dataFormatada = formatDate(start_at);
  const horaInicio = formatTime(start_at);
  const horaFim = formatTime(end_at);

  const telefoneRecrutamento = '41379504026';
  const whatsappUrl = `https://wa.me/55${telefoneRecrutamento}`;

  // Build candidaturas válidas section
  let candidaturasSection = '';
  if (candidaturas_validas && candidaturas_validas.length > 0) {
    const lista = candidaturas_validas.map(v => `• ${v}`).join('\n');
    candidaturasSection = `<b>Candidaturas Válidas</b>
${lista}

`;
  }

  return `<b>Aula-Teste</b>
Unidade: ${unidade_nome}
Vaga: ${job_name}
Data: ${dataFormatada} | ${horaInicio} às ${horaFim}
Local: ${endereco_unidade || 'A definir'}
Contato unidade: <a href="mailto:${email_unidade_contato}">${email_unidade_contato}</a>

${candidaturasSection}<b>Candidato</b>
${candidate_name} | CPF: ${candidate_cpf || 'Não informado'}
Email: <a href="mailto:${candidate_email}">${candidate_email}</a>
Celular: ${candidate_phone || 'Não informado'}

<b>IMPORTANTE!!!</b> Coordenador, preencha a rúbrica ao finalizar a entrevista: <a href="${rubrica_url}">📋 Rúbrica (restrita ao coordenador)</a>

<b>Dúvidas | Problemas</b>
<a href="mailto:recrutamento@tomeducacao.com.br">recrutamento@tomeducacao.com.br</a> | <a href="${whatsappUrl}">(41) 3795-0426</a>`.trim();
}

/**
 * Fetch CV data for a candidate, syncing from Gupy if needed.
 * Uses cvSync.getCandidateCv which automatically fetches from Gupy
 * when cv_data is missing or cache is expired.
 *
 * @param {number} candidateId - Local candidate ID
 * @returns {Promise<Object|null>} CV data or null if not found/sync failed
 */
async function getCandidateCvData(candidateId) {
  if (!candidateId) return null;

  try {
    const cvData = await getCandidateCv(candidateId);
    // Remove metadata fields that cvSync adds (fromCache, syncedAt, noGupyId)
    if (cvData) {
      const { fromCache, syncedAt, noGupyId, ...cleanCvData } = cvData;
      return cleanCvData;
    }
    return null;
  } catch (error) {
    console.error(`[CalendarService] Error fetching/syncing CV for candidate ${candidateId}:`, error.message);
    return null;
  }
}

/**
 * Generate CV PDF and upload to Drive
 * Returns null on failure (fallback: event created without attachment)
 *
 * @param {number} candidateId - Local candidate ID
 * @param {string} candidateName - Candidate name (for filename)
 * @param {string} organizerEmail - Organizer email (Drive owner)
 * @returns {Promise<Array|null>} Attachments array or null
 */
async function prepareCvAttachment(candidateId, candidateName, organizerEmail) {
  try {
    // 1. Fetch CV data
    const cvData = await getCandidateCvData(candidateId);
    if (!cvData) {
      // Expected case: candidate has no CV data - not an error
      console.log(`[CalendarService] No CV data for candidate ${candidateId}, skipping attachment`);
      return null;
    }

    // Ensure cvData has nome for the PDF
    if (!cvData.nome && candidateName) {
      cvData.nome = candidateName;
    }

    // 2. Generate PDF
    const { buffer, filename } = await generateCvPdf(cvData);
    console.log(`[CalendarService] Generated PDF: ${filename} (${buffer.length} bytes)`);

    // 3. Upload to Drive (pass context for error logging)
    const { webViewLink } = await uploadCvPdf(buffer, filename, organizerEmail, {
      candidateId,
    });

    // 4. Return attachment array for calendar event
    return [{
      fileUrl: webViewLink,
      title: filename,
      mimeType: 'application/pdf',
      iconLink: 'https://drive-thirdparty.googleusercontent.com/16/type/application/pdf',
    }];
  } catch (error) {
    // Log full error with stack trace for debugging (error is unexpected at this point)
    console.error(`[CalendarService] FAILED to prepare CV attachment for candidate ${candidateId}:`, error);
    // Graceful degradation - booking proceeds without attachment
    return null;
  }
}

/**
 * Cria evento de booking na agenda da unidade
 *
 * Cria um único evento:
 * - Organizador: email_unidade_contato (via delegação de domínio)
 * - Calendário: agenda_url (calendário da unidade)
 * - Candidato como attendee (recebe convite por email)
 *
 * @param {object} params - Parâmetros do evento
 * @param {string} params.email_organizador - Email do organizador (email_unidade_contato)
 * @param {string} params.agenda_url - ID do calendário da unidade
 * @param {string} params.email_candidato - Email do candidato
 * @param {string} params.candidate_name - Nome do candidato
 * @param {string} params.candidate_email - Email do candidato
 * @param {string} params.candidate_cpf - CPF do candidato
 * @param {string} params.candidate_phone - Celular do candidato
 * @param {string} params.job_name - Nome da vaga
 * @param {string} params.unidade_nome - Nome da unidade
 * @param {string} params.endereco_unidade - Endereço da unidade
 * @param {string} params.email_unidade_contato - Email de contato da unidade
 * @param {string} params.start_at - Data/hora início (ISO8601)
 * @param {string} params.end_at - Data/hora fim (ISO8601)
 * @param {string} params.rubrica_url - URL da rúbrica pré-preenchida
 * @param {boolean} params.is_manual - Se é agendamento manual
 * @param {string[]} params.candidaturas_validas - Lista de vagas válidas do candidato na unidade
 * @returns {Promise<{id_calendar_event_unidade: string, id_calendar_event_candidato: string}>}
 */
async function createBookingEvents({
  email_organizador,
  agenda_url,
  email_candidato,
  candidate_name,
  candidate_email,
  candidate_cpf,
  candidate_phone,
  job_name,
  unidade_nome,
  endereco_unidade,
  email_unidade_contato,
  start_at,
  end_at,
  rubrica_url,
  is_manual = false,
  candidaturas_validas = [],
  candidate_id = null,
}) {
  // Título do evento (padronizado, sem distinção manual/candidato)
  const title = `Aula-Teste: ${job_name}`;

  // Descrição HTML rica
  const description = buildEventDescription({
    unidade_nome,
    job_name,
    start_at,
    end_at,
    endereco_unidade,
    email_unidade_contato,
    candidate_name,
    candidate_cpf,
    candidate_email: candidate_email || email_candidato,
    candidate_phone,
    rubrica_url: rubrica_url || 'https://forms.google.com/placeholder',
    candidaturas_validas
  });

  // Prepare CV attachment (with fallback - if fails, event created without attachment)
  let attachments = [];
  if (candidate_id) {
    const cvAttachment = await prepareCvAttachment(candidate_id, candidate_name, email_organizador);
    if (cvAttachment) {
      attachments = cvAttachment;
      console.log(`[CalendarService] CV attachment prepared for candidate ${candidate_id}`);
    } else {
      console.log(`[CalendarService] No CV attachment for candidate ${candidate_id} (cv not available or generation failed)`);
    }
  }

  // Criar evento na agenda da unidade com candidato como attendee
  // Usa createEventInCalendar para especificar o calendário de destino
  // skipConference: true = não criar Google Meet (aula teste é presencial)
  const event = await googleCalendar.createEventInCalendar(
    email_organizador,  // Impersona este email (delegação de domínio)
    agenda_url,         // Calendário de destino (agenda da unidade)
    {
      summary: title,
      description,
      location: endereco_unidade,
      start: start_at,
      end: end_at,
      attendees: [{
        email: email_candidato,
        displayName: candidate_name
      }],
      skipConference: true,  // Aula teste é presencial, não precisa de Meet
      attachments,
    }
  );

  const origem = is_manual ? 'recrutamento' : 'candidato';
  console.log(`[CalendarService:${origem}] Evento criado: ${event.id} na agenda ${agenda_url}`);

  // Retorna o mesmo ID para ambos os campos (compatibilidade com código existente)
  // Antes eram 2 eventos, agora é 1 só
  return {
    id_calendar_event_unidade: event.id,
    id_calendar_event_candidato: event.id
  };
}

/**
 * Deleta eventos de booking (nao bloqueia em caso de erro)
 *
 * Como agora é um único evento, deleta apenas uma vez mesmo que os IDs sejam iguais.
 */
async function deleteBookingEvents({
  email_organizador,
  agenda_url,
  id_calendar_event_unidade,
  id_calendar_event_candidato,
  // Mantém compatibilidade com código antigo
  email_agendador
}) {
  const results = { unidade: false, candidato: false };

  // Usa os novos parâmetros ou fallback para os antigos
  const orgEmail = email_organizador || email_agendador;
  const calendarId = agenda_url || orgEmail;

  // Se os IDs são iguais (novo comportamento), deleta apenas uma vez
  const idsIguais = id_calendar_event_unidade === id_calendar_event_candidato;

  if (id_calendar_event_unidade) {
    try {
      await googleCalendar.deleteEventFromCalendar(orgEmail, calendarId, id_calendar_event_unidade);
      results.unidade = true;
      if (idsIguais) results.candidato = true;
    } catch (err) {
      console.error(`[Calendar] Erro ao deletar evento unidade: ${err.message}`);
    }
  }

  // Só tenta deletar o segundo se os IDs forem diferentes
  if (id_calendar_event_candidato && !idsIguais) {
    try {
      await googleCalendar.deleteEventFromCalendar(orgEmail, calendarId, id_calendar_event_candidato);
      results.candidato = true;
    } catch (err) {
      console.error(`[Calendar] Erro ao deletar evento candidato: ${err.message}`);
    }
  }

  return results;
}

/**
 * Atualiza evento com link da rubrica
 */
async function updateEventWithRubrica(email_organizador, agenda_url, eventId, rubricaUrl) {
  // Se agenda_url não for passado, usa email_organizador como calendário (compatibilidade)
  const calendarId = agenda_url || email_organizador;

  return googleCalendar.updateEvent(email_organizador, eventId, {
    description: `Link da rubrica: ${rubricaUrl}`
  });
}

module.exports = {
  createBookingEvents,
  deleteBookingEvents,
  updateEventWithRubrica,
  // Exporta helpers para uso em testes
  buildEventDescription,
  formatDate,
  formatTime,
  // Add for testing:
  getCandidateCvData,
  prepareCvAttachment,
};
