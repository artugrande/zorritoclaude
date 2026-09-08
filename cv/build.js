// Genera el CV en .docx (para portales ATS) y .html (para imprimir a PDF)
// a partir de los .md de esta carpeta. Uso: node cv/build.js
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, BorderStyle, LevelFormat, convertInchesToTwip,
} = require('docx');

const FONT = 'Calibri';
const BODY = 20; // 10 pt, en medios puntos

const SOURCES = [
  { md: 'cv-arturo-grande-en.md', base: 'CV_Arturo_Grande' },
];

// --- Parser: markdown acotado -> lista de tokens --------------------------
function parse(mdPath) {
  const tokens = [];
  let seenContact = false;

  for (const raw of fs.readFileSync(mdPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('# ')) { tokens.push({ type: 'name', text: line.slice(2) }); continue; }
    if (line.startsWith('## ')) { tokens.push({ type: 'section', text: line.slice(3).toUpperCase() }); continue; }
    if (line.startsWith('- ')) { tokens.push({ type: 'bullet', text: line.slice(2) }); continue; }
    if (!seenContact) { seenContact = true; tokens.push({ type: 'contact', text: line }); continue; }

    const isDate = /^\[?(MM\/|\d{2}\/)/.test(line);
    tokens.push({ type: isDate ? 'date' : 'para', text: line });
  }
  return tokens;
}

// **negrita** inline -> fragmentos
const split = (text) => text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((c) => {
  const bold = c.startsWith('**') && c.endsWith('**');
  return { text: bold ? c.slice(2, -2) : c, bold };
});

// --- Salida .docx ---------------------------------------------------------
function runs(text, opts = {}) {
  return split(text).map(({ text: t, bold }) => new TextRun({
    text: t, bold: bold || opts.bold, italics: opts.italics, font: FONT, size: opts.size || BODY,
  }));
}

function toDocx(tokens) {
  const children = tokens.map((tk) => {
    switch (tk.type) {
      case 'name':
        return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: runs(tk.text, { bold: true, size: 30 }) });
      case 'contact':
        return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: runs(tk.text, { size: 18 }) });
      case 'section':
        return new Paragraph({
          spacing: { before: 200, after: 70 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 2 } },
          children: runs(tk.text, { bold: true, size: 22 }),
        });
      case 'bullet':
        return new Paragraph({ numbering: { reference: 'cv-bullets', level: 0 }, spacing: { after: 30 }, children: runs(tk.text) });
      case 'date':
        return new Paragraph({ spacing: { after: 40 }, children: runs(tk.text, { italics: true, size: 18 }) });
      default:
        return new Paragraph({ spacing: { before: 90, after: 30 }, children: runs(tk.text) });
    }
  });

  return new Document({
    creator: 'Arturo Grande',
    title: 'CV Arturo Grande',
    styles: { default: { document: { run: { font: FONT, size: BODY } } } },
    numbering: {
      config: [{
        reference: 'cv-bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: convertInchesToTwip(0.2), hanging: convertInchesToTwip(0.14) } } },
        }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 850, right: 850 } } },
      children,
    }],
  });
}

// --- Salida .html (para "Imprimir > Guardar como PDF") --------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (text) => split(text).map(({ text: t, bold }) => (bold ? `<strong>${esc(t)}</strong>` : esc(t))).join('');

function toHtml(tokens, lang) {
  const body = [];
  let inList = false;
  const closeList = () => { if (inList) { body.push('</ul>'); inList = false; } };

  for (const tk of tokens) {
    if (tk.type === 'bullet') {
      if (!inList) { body.push('<ul>'); inList = true; }
      body.push(`<li>${inline(tk.text)}</li>`);
      continue;
    }
    closeList();
    if (tk.type === 'name') body.push(`<h1>${inline(tk.text)}</h1>`);
    else if (tk.type === 'contact') body.push(`<p class="contact">${inline(tk.text)}</p>`);
    else if (tk.type === 'section') body.push(`<h2>${inline(tk.text)}</h2>`);
    else if (tk.type === 'date') body.push(`<p class="date">${inline(tk.text)}</p>`);
    else body.push(`<p>${inline(tk.text)}</p>`);
  }
  closeList();

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>CV Arturo Grande</title>
<style>
  @page { size: Letter; margin: 0.5in 0.6in; }
  body { font-family: Calibri, Carlito, Arial, sans-serif; font-size: 10pt; line-height: 1.18; color: #000; max-width: 7.3in; margin: 0.5in auto; }
  h1 { font-size: 15pt; text-align: center; margin: 0 0 2pt; letter-spacing: .5px; }
  .contact { text-align: center; font-size: 9pt; margin: 0 0 6pt; }
  h2 { font-size: 11pt; margin: 6pt 0 3pt; padding-bottom: 1pt; border-bottom: 1px solid #000; }
  p { margin: 4pt 0 2pt; }
  p.date { font-style: italic; font-size: 9pt; margin: 0 0 2pt; }
  ul { margin: 0 0 2pt; padding-left: 15pt; }
  li { margin: 0 0 0.5pt; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>`;
}

(async () => {
  const outDir = path.join(__dirname, 'dist');
  fs.mkdirSync(outDir, { recursive: true });

  for (const { md, base } of SOURCES) {
    const tokens = parse(path.join(__dirname, md));
    fs.writeFileSync(path.join(outDir, `${base}.docx`), await Packer.toBuffer(toDocx(tokens)));
    fs.writeFileSync(path.join(outDir, `${base}.html`), toHtml(tokens, 'en'));
    console.log('->', `dist/${base}.docx`, `dist/${base}.html`);
  }
})();
