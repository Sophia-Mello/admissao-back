const moment = require('moment-timezone');
const db = require('../../db');

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Busca config de horários (com valid_from/valid_until)
 * Prioridade: unidade específica > global
 */
async function getScheduleConfig(id_unidade) {
  // Cast slot_size to text for consistent string format
  const baseQuery = `
    SELECT id_config, id_unidade, morning_start_at, morning_end_at,
      afternoon_start_at, afternoon_end_at, slot_size::text as slot_size,
      d_rule_start, d_rule_end, active, created_at, updated_at, valid_from, valid_until
    FROM schedule_config`;

  const specific = await db.query(`
    ${baseQuery}
    WHERE id_unidade = $1 AND active = true
    LIMIT 1
  `, [id_unidade]);

  if (specific.rows.length > 0) {
    return specific.rows[0];
  }

  const global = await db.query(`
    ${baseQuery}
    WHERE id_unidade IS NULL AND active = true
    LIMIT 1
  `);

  return global.rows[0] || null;
}

/**
 * Calcula range de datas aplicando d_rules E valid_from/valid_until
 * Retorna o menor range entre os dois (usado no fluxo público)
 */
function applyDRulesWithValidity(config) {
  const today = moment().tz(TIMEZONE).startOf('day');

  // Range por d_rules
  const dRuleStart = today.clone().add(config.d_rule_start || 1, 'days');
  const dRuleEnd = today.clone().add(config.d_rule_end || 30, 'days');

  // Range por validity (null = sem limite)
  const validFrom = config.valid_from
    ? moment(config.valid_from).tz(TIMEZONE).startOf('day')
    : null;
  const validUntil = config.valid_until
    ? moment(config.valid_until).tz(TIMEZONE).startOf('day')
    : null;

  // Calcula o menor range
  let start = dRuleStart;
  let end = dRuleEnd;

  if (validFrom && validFrom.isAfter(start)) {
    start = validFrom;
  }
  if (validUntil && validUntil.isBefore(end)) {
    end = validUntil;
  }

  // Se start > end, range inválido
  if (start.isAfter(end)) {
    return null;
  }

  return {
    start_date: start.format('YYYY-MM-DD'),
    end_date: end.format('YYYY-MM-DD')
  };
}

/**
 * Calcula range usando apenas valid_from/valid_until (usado no fluxo privado)
 */
function applyValidity(config) {
  const today = moment().tz(TIMEZONE).startOf('day');

  const validFrom = config.valid_from
    ? moment(config.valid_from).tz(TIMEZONE).startOf('day')
    : today;
  const validUntil = config.valid_until
    ? moment(config.valid_until).tz(TIMEZONE).startOf('day')
    : today.clone().add(90, 'days'); // fallback 90 dias

  return {
    start_date: validFrom.format('YYYY-MM-DD'),
    end_date: validUntil.format('YYYY-MM-DD')
  };
}

/**
 * Pagina range de datas por semana (segunda a sábado, excluindo domingos)
 * @param {string} data_ini - Data inicial (YYYY-MM-DD)
 * @param {string} data_fim - Data final (YYYY-MM-DD)
 * @param {number|null} page - Página solicitada (deve ser número natural >= 1, ou null para auto)
 * @returns {object} - { start_date, end_date, currentPage, totalPages, error? }
 */
function paginateByWeek(data_ini, data_fim, page = null) {
  const start = moment(data_ini).tz(TIMEZONE).startOf('day');
  const end = moment(data_fim).tz(TIMEZONE).startOf('day');

  // Se começa no domingo, pular para segunda
  if (start.day() === 0) {
    start.add(1, 'day');
  }

  // Se termina no domingo, voltar para sábado
  if (end.day() === 0) {
    end.subtract(1, 'day');
  }

  // Se após ajustes start > end, não há dias úteis
  if (start.isAfter(end)) {
    return {
      start_date: data_ini,
      end_date: data_fim,
      currentPage: 0,
      totalPages: 0,
      error: 'Nenhuma semana disponível no período (apenas domingos)'
    };
  }

  const weeks = [];
  let weekStart = start.clone();

  while (weekStart.isSameOrBefore(end)) {
    // Encontra o fim da semana (sábado) ou o fim do range
    let weekEnd = weekStart.clone();

    // Avança até sábado (day() === 6) ou até end
    while (weekEnd.day() !== 6 && weekEnd.isBefore(end)) {
      weekEnd.add(1, 'day');
    }

    // Se passou do end, ajusta (end já não é domingo por causa do ajuste acima)
    if (weekEnd.isAfter(end)) {
      weekEnd = end.clone();
    }

    weeks.push({
      start: weekStart.format('YYYY-MM-DD'),
      end: weekEnd.format('YYYY-MM-DD')
    });

    // Próxima semana começa na segunda (pula domingo)
    weekStart = weekEnd.clone().add(1, 'day');
    if (weekStart.day() === 0) {
      weekStart.add(1, 'day');
    }
  }

  const totalPages = weeks.length;

  // Se não há semanas, retorna erro
  if (totalPages === 0) {
    return {
      start_date: data_ini,
      end_date: data_fim,
      currentPage: 0,
      totalPages: 0,
      error: 'Nenhuma semana disponível no período'
    };
  }

  let currentPage = page;

  // Se page é null, calcula automaticamente baseado em hoje
  if (currentPage === null) {
    const today = moment().tz(TIMEZONE).startOf('day');
    currentPage = 1;

    for (let i = 0; i < weeks.length; i++) {
      const wStart = moment(weeks[i].start);
      const wEnd = moment(weeks[i].end);

      if (today.isSameOrAfter(wStart) && today.isSameOrBefore(wEnd)) {
        currentPage = i + 1;
        break;
      }
      if (today.isBefore(wStart)) {
        currentPage = i + 1;
        break;
      }
    }
  }

  // Valida que page está dentro do range válido
  if (currentPage < 1 || currentPage > totalPages) {
    return {
      start_date: weeks[0].start,
      end_date: weeks[0].end,
      currentPage: 1,
      totalPages,
      error: `Página ${page} inválida. Deve ser entre 1 e ${totalPages}`
    };
  }

  const selectedWeek = weeks[currentPage - 1];

  return {
    start_date: selectedWeek.start,
    end_date: selectedWeek.end,
    currentPage,
    totalPages
  };
}

/**
 * Gera slots usando função PostgreSQL get_slots
 * @param {object} params - { id_unidade, start_date, end_date, config }
 * @returns {array} - Array de slots com status
 */
async function getSlots({ id_unidade, start_date, end_date, config }) {
  // Usa a função PostgreSQL que já filtra domingos e calcula status
  const result = await db.query(`
    SELECT
      date,
      day_of_week,
      slot_start,
      slot_end,
      status,
      id_booking,
      id_application_gupy,
      job_name,
      id_job_gupy,
      id_block,
      block_reason
    FROM ${db.schema}.get_slots(
      $1::integer,
      $2::date,
      $3::date,
      $4::time,
      $5::time,
      $6::time,
      $7::time,
      $8::interval
    )
  `, [
    id_unidade,
    start_date,
    end_date,
    config.morning_start_at,
    config.morning_end_at,
    config.afternoon_start_at,
    config.afternoon_end_at,
    config.slot_size
  ]);

  // Formata os resultados para o padrão esperado pelo frontend
  return result.rows.map(row => ({
    date: moment(row.date).format('YYYY-MM-DD'),
    day_of_week: row.day_of_week,
    slot_start: moment(row.slot_start).tz(TIMEZONE).format('HH:mm'),
    slot_end: moment(row.slot_end).tz(TIMEZONE).format('HH:mm'),
    status: row.status,
    // Campos extras para admin
    ...(row.id_booking && {
      id_booking: row.id_booking,
      id_application_gupy: row.id_application_gupy,
      job_name: row.job_name,
      id_job_gupy: row.id_job_gupy
    }),
    ...(row.id_block && {
      id_block: row.id_block,
      block_reason: row.block_reason
    })
  }));
}

/**
 * Filtra slots para exibição pública (só vagos, remove sábado)
 */
function filterPublicSlots(slots) {
  return slots
    .filter(s => {
      if (s.status !== 'vago') return false;
      return s.day_of_week !== 'Saturday' && s.day_of_week !== 'Sábado';
    })
    .map(({ date, day_of_week, slot_start, slot_end, status }) => ({
      date, day_of_week, slot_start, slot_end, status
    }));
}

/**
 * Enriquece slots ocupados com dados do candidato das tabelas locais (candidate + application)
 * @param {Array} slots - Slots retornados de getSlots
 * @returns {Promise<Array>} - Slots enriquecidos com candidate_name, candidate_cpf, candidate_email, candidate_phone
 */
async function enrichSlotsWithCandidateData(slots) {
  const occupiedSlots = slots.filter(s =>
    s.status === 'ocupado' && s.id_application_gupy
  );

  if (occupiedSlots.length === 0) return slots;

  // Buscar dados das tabelas locais (candidate + application)
  const applicationIds = occupiedSlots.map(s => s.id_application_gupy);
  const localData = await db.query(
    `SELECT a.id_application_gupy, c.nome, c.cpf, c.email, c.telefone
     FROM application a
     JOIN candidate c ON c.id = a.id_candidate
     WHERE a.id_application_gupy = ANY($1)`,
    [applicationIds]
  );

  // Criar mapa de dados
  const candidateMap = new Map();
  localData.rows.forEach(row => {
    candidateMap.set(row.id_application_gupy, {
      name: row.nome,
      cpf: row.cpf,
      email: row.email,
      phone: row.telefone
    });
  });

  // Enriquecer slots
  return slots.map(slot => {
    if (slot.status !== 'ocupado' || !slot.id_application_gupy) return slot;

    const candidate = candidateMap.get(slot.id_application_gupy);
    if (!candidate) return slot;

    return {
      ...slot,
      candidate_name: candidate.name,
      candidate_cpf: candidate.cpf,
      candidate_email: candidate.email,
      candidate_phone: candidate.phone
    };
  });
}

module.exports = {
  getScheduleConfig,
  applyDRulesWithValidity,
  applyValidity,
  paginateByWeek,
  getSlots,
  filterPublicSlots,
  enrichSlotsWithCandidateData,
  TIMEZONE
};
