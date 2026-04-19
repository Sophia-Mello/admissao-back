/**
 * Booking Helpers
 *
 * Shared utility functions for booking operations.
 * Used by both public-bookings.js and admin-bookings.js routes.
 */
const moment = require('moment-timezone');

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Format date range for calendar event descriptions
 *
 * @param {string} start_at - ISO 8601 datetime
 * @param {string} end_at - ISO 8601 datetime
 * @returns {string} Formatted string like "07/11/2025 das 14:00 às 14:40"
 */
function formatHorario(start_at, end_at) {
  const start = moment(start_at).tz(TIMEZONE);
  const end = moment(end_at).tz(TIMEZONE);

  return `${start.format('DD/MM/YYYY')} das ${start.format('HH:mm')} às ${end.format('HH:mm')}`;
}

/**
 * Format date in Brazilian format
 *
 * @param {string|Date} dateString - Date to format
 * @returns {string} Formatted date like "07/11/2025"
 */
function formatDateBR(dateString) {
  return moment(dateString).tz(TIMEZONE).format('DD/MM/YYYY');
}

/**
 * Format time in HH:mm format
 *
 * @param {string|Date} dateString - DateTime to format
 * @returns {string} Formatted time like "14:00"
 */
function formatTime(dateString) {
  return moment(dateString).tz(TIMEZONE).format('HH:mm');
}

/**
 * Format weekday name in Portuguese
 *
 * @param {string|Date} dateString - Date to format
 * @returns {string} Weekday name like "segunda-feira"
 */
function formatWeekday(dateString) {
  return moment(dateString).tz(TIMEZONE).locale('pt-br').format('dddd');
}

/**
 * Get current date in Brazil timezone
 *
 * @returns {moment.Moment} Current moment in Brazil timezone
 */
function getCurrentDateBrazil() {
  return moment().tz(TIMEZONE);
}

/**
 * Get tomorrow's date in Brazil timezone (for d+1 rule)
 *
 * @returns {moment.Moment} Tomorrow's date in Brazil timezone
 */
function getTomorrowBrazil() {
  return moment().tz(TIMEZONE).add(1, 'day').startOf('day');
}

/**
 * Check if a date is tomorrow (d+1 validation)
 *
 * @param {string|Date} date - Date to check
 * @returns {boolean} True if date is tomorrow
 */
function isTomorrow(date) {
  const tomorrow = getTomorrowBrazil();
  const checkDate = moment(date).tz(TIMEZONE).startOf('day');
  return checkDate.isSame(tomorrow, 'day');
}

/**
 * Validate d+1 rule - booking must be for tomorrow
 *
 * @param {string|Date} start_at - Booking start datetime
 * @returns {object} { valid: boolean, message?: string }
 */
function validateD1Rule(start_at) {
  const startDate = moment(start_at).tz(TIMEZONE);
  const tomorrow = getTomorrowBrazil();
  const dayAfterTomorrow = moment(tomorrow).add(1, 'day');

  if (startDate.isBefore(tomorrow) || startDate.isSameOrAfter(dayAfterTomorrow)) {
    return {
      valid: false,
      message: 'Agendamento permitido apenas para amanhã (d+1)',
    };
  }

  return { valid: true };
}

module.exports = {
  formatHorario,
  formatDateBR,
  formatTime,
  formatWeekday,
  getCurrentDateBrazil,
  getTomorrowBrazil,
  isTomorrow,
  validateD1Rule,
  TIMEZONE,
};
