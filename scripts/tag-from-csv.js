#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const API_KEY = process.argv[2] || process.env.GUPY_API_KEY;
const CSV_PATH = path.join(__dirname, '../../docs/applications_para_tag_desligado.csv');
const TAG_NAME = 'desligado';
const BASE_URL = 'https://api.gupy.io/api/v1';

if (!API_KEY) {
  console.error('Uso: node tag-from-csv.js <API_KEY>');
  process.exit(1);
}

async function addTag(jobId, applicationId) {
  const url = `${BASE_URL}/jobs/${jobId}/applications/${applicationId}/tags`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: TAG_NAME })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }

  return response.json();
}

async function main() {
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.trim().split('\n').slice(1); // skip header

  console.log(`Aplicando tag "${TAG_NAME}" em ${lines.length} applications...\n`);

  let success = 0, failed = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    const [applicationId, jobId, cpf, nome] = line.split(',');

    try {
      await addTag(jobId, applicationId);
      console.log(`✓ ${nome} (${cpf})`);
      success++;
    } catch (error) {
      console.log(`✗ ${nome} (${cpf}) - ${error.message}`);
      failed++;
    }

    // Delay para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n--- Resultado ---`);
  console.log(`Sucesso: ${success}`);
  console.log(`Falha: ${failed}`);
}

main().catch(console.error);
