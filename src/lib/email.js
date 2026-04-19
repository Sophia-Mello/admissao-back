const nodemailer = require('nodemailer');

const smtpUrl = process.env.SMTP_URL || null; // optional full SMTP url
const smtpHost = process.env.SMTP_HOST || null;
const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT,10) : null;
const smtpUser = process.env.SMTP_USER || null;
const smtpPass = process.env.SMTP_PASS || null;
const fromAddress = process.env.SMTP_FROM || 'no-reply@local.test';

let transporter;
if (smtpUrl) {
  transporter = nodemailer.createTransport(smtpUrl);
} else if (smtpHost) {
  transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort || 587, secure: false, auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined });
} else {
  transporter = null; // send disabled
}

async function sendTempPasswordEmail(to, tempPassword) {
  if (!transporter) {
    console.warn('[email] transporter not configured, skipping send to', to);
    return false;
  }
  const html = `<p>Seu usuário foi criado. Email: <b>${to}</b></p><p>Senha temporária: <b>${tempPassword}</b></p><p>Por favor altere sua senha após o primeiro acesso.</p>`;
  const info = await transporter.sendMail({ from: fromAddress, to, subject: 'Criação de usuário - RH SISTEMA', html });
  return info;
}

module.exports = { sendTempPasswordEmail };
