const moment = require('moment-timezone');

const TIMEZONE = 'America/Sao_Paulo';

function formatHorario(date) {
  return moment(date).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
}

function formatDate(date) {
  return moment(date).tz(TIMEZONE).format('DD/MM/YYYY');
}

function today() {
  return moment().tz(TIMEZONE).startOf('day');
}

module.exports = { formatHorario, formatDate, today, TIMEZONE };
