/**
 * CV PDF Generator
 * Generates professional PDF from candidate cv_data using PDFKit.
 */

const PDFDocument = require('pdfkit');

// Known degree type prefixes to detect if course already includes degree type
const DEGREE_PREFIXES = [
  'Pós-Graduação',
  'Pós Graduação',
  'Graduação',
  'Licenciatura',
  'Bacharelado',
  'Tecnólogo',
  'Formação Superior',
  'Técnico',
  'Tecnico',
  'MBA',
  'Mestrado',
  'Doutorado',
  'Especialização',
  'Ensino Médio',
];

// Color palette - professional blue theme
const COLORS = {
  primary: '#1a365d',      // Dark blue for headers
  secondary: '#2d3748',    // Dark gray for body text
  accent: '#3182ce',       // Blue for accents
  muted: '#718096',        // Gray for secondary text
  divider: '#e2e8f0',      // Light gray for lines
};

// Font sizes
const SIZES = {
  title: 18,
  sectionTitle: 12,
  body: 10,
  small: 9,
};

// Page layout constants
const PAGE = {
  margin: 50,
  maxY: 720, // Max Y position before needing a new page (leave room for footer at 780)
  footerY: 780,
};

/**
 * Check if we need a new page and add one if necessary
 * @param {PDFDocument} doc - PDFKit document instance
 * @param {number} y - Current Y position
 * @param {number} [requiredSpace=50] - Minimum space needed for next content
 * @returns {number} New Y position (reset if new page added)
 */
function checkPageOverflow(doc, y, requiredSpace = 50) {
  if (y + requiredSpace > PAGE.maxY) {
    doc.addPage();
    return PAGE.margin; // Reset Y to top margin
  }
  return y;
}

/**
 * Format education entry title avoiding duplication.
 * If course already starts with a known degree type, use it as is.
 * Otherwise, format as "grau em curso".
 * @param {Object} f - Education entry with grau and curso
 * @returns {string}
 */
function formatEducationTitle(f) {
  const grau = f.grau || '';
  const curso = f.curso || '';

  if (!curso) {
    return grau;
  }

  // Check if curso already starts with a known degree type prefix
  const cursoUpper = curso.toUpperCase();
  const startsWithDegree = DEGREE_PREFIXES.some(prefix =>
    cursoUpper.startsWith(prefix.toUpperCase())
  );

  if (startsWithDegree) {
    // Course already includes the degree type, use as is
    return curso;
  }

  // Otherwise, combine grau + curso
  if (grau) {
    return `${grau} em ${curso}`;
  }
  return curso;
}

/**
 * Sanitize filename - remove special characters
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-zA-Z0-9\s]/g, '')  // Remove special chars
    .replace(/\s+/g, '_')            // Spaces to underscores
    .substring(0, 50);               // Limit length
}

/**
 * Draw a section header with divider line
 */
function drawSectionHeader(doc, title, y) {
  doc
    .fontSize(SIZES.sectionTitle)
    .fillColor(COLORS.primary)
    .font('Helvetica-Bold')
    .text(title.toUpperCase(), 50, y);

  doc
    .strokeColor(COLORS.divider)
    .lineWidth(1)
    .moveTo(50, y + 16)
    .lineTo(545, y + 16)
    .stroke();

  return y + 25;
}

/**
 * Generate professional CV PDF from cv_data
 * @param {Object} cvData - Candidate CV data
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
async function generateCvPdf(cvData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `CV - ${cvData.nome || 'Candidato'}`,
          Author: 'RS Admissão - TOM Educação',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const filename = `CV_${sanitizeFilename(cvData.nome || 'Candidato')}_${Date.now()}.pdf`;
        resolve({ buffer, filename });
      });
      doc.on('error', reject);

      // ===== HEADER - Candidate Name =====
      doc
        .fontSize(SIZES.title)
        .fillColor(COLORS.primary)
        .font('Helvetica-Bold')
        .text(cvData.nome || 'Nome não informado', 50, 50, { align: 'center' });

      // ===== CONTACT INFO =====
      let y = 80;
      const contactParts = [];
      if (cvData.email) contactParts.push(cvData.email);
      if (cvData.telefone) contactParts.push(cvData.telefone);
      if (cvData.endereco) contactParts.push(cvData.endereco);

      if (contactParts.length > 0) {
        doc
          .fontSize(SIZES.body)
          .fillColor(COLORS.muted)
          .font('Helvetica')
          .text(contactParts.join('  |  '), 50, y, { align: 'center' });
        y += 30;
      }

      // ===== FORMAÇÃO ACADÊMICA =====
      const formacao = cvData.formacao || [];
      if (formacao.length > 0) {
        y = checkPageOverflow(doc, y, 60); // Need space for header + at least one item
        y = drawSectionHeader(doc, 'Formação Acadêmica', y);

        formacao.forEach((f) => {
          y = checkPageOverflow(doc, y, 40); // Space for one education entry
          doc
            .fontSize(SIZES.body)
            .fillColor(COLORS.secondary)
            .font('Helvetica-Bold')
            .text(formatEducationTitle(f), 50, y);
          y += 14;

          doc
            .fontSize(SIZES.small)
            .fillColor(COLORS.muted)
            .font('Helvetica')
            .text(`${f.instituicao || ''} ${f.periodo ? `| ${f.periodo}` : ''}`, 50, y);
          y += 18;
        });
        y += 10;
      }

      // ===== EXPERIÊNCIA PROFISSIONAL =====
      const experiencia = cvData.experiencia || [];
      if (experiencia.length > 0) {
        y = checkPageOverflow(doc, y, 60); // Need space for header + at least one item
        y = drawSectionHeader(doc, 'Experiência Profissional', y);

        experiencia.forEach((e) => {
          y = checkPageOverflow(doc, y, 80); // Space for one experience entry (larger due to description)
          doc
            .fontSize(SIZES.body)
            .fillColor(COLORS.secondary)
            .font('Helvetica-Bold')
            .text(e.cargo || '', 50, y);
          y += 14;

          doc
            .fontSize(SIZES.small)
            .fillColor(COLORS.muted)
            .font('Helvetica')
            .text(`${e.empresa || ''} ${e.periodo ? `| ${e.periodo}` : ''}`, 50, y);
          y += 14;

          if (e.descricao) {
            // Truncate to 300 chars to prevent PDF page overflow on multi-experience CVs
            const desc = e.descricao.length > 300
              ? e.descricao.substring(0, 300) + '...'
              : e.descricao;

            // Check if description will overflow
            const descHeight = doc.heightOfString(desc, { width: 495 });
            y = checkPageOverflow(doc, y, descHeight + 20);

            doc
              .fontSize(SIZES.small)
              .fillColor(COLORS.secondary)
              .font('Helvetica')
              .text(desc, 50, y, { width: 495 });
            y += descHeight + 8;
          }
          y += 10;
        });
      }

      // ===== IDIOMAS =====
      const idiomas = cvData.idiomas || [];
      if (idiomas.length > 0) {
        y = checkPageOverflow(doc, y, 50); // Need space for header + languages line
        y = drawSectionHeader(doc, 'Idiomas', y);

        const idiomasText = idiomas
          .map((i) => `${i.nome || ''} (${i.nivel || ''})`)
          .join('  •  ');

        doc
          .fontSize(SIZES.body)
          .fillColor(COLORS.secondary)
          .font('Helvetica')
          .text(idiomasText, 50, y);
        y += 20;
      }

      // ===== FOOTER (on last page only) =====
      doc
        .fontSize(8)
        .fillColor(COLORS.muted)
        .font('Helvetica')
        .text(
          `Gerado automaticamente por RS Admissão - ${new Date().toLocaleDateString('pt-BR')}`,
          50,
          PAGE.footerY,
          { align: 'center' }
        );

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateCvPdf,
  sanitizeFilename,
};
