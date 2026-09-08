# CV ATS-friendly — Arturo Grande

Formato de una página, columna única, pensado para pasar los filtros ATS
(Applicant Tracking System: Workday, Greenhouse, Lever, SmartRecruiters, Taleo)
y siguiendo la estructura de las guías de Harvard OCS: viñetas de
**verbo de acción + qué + cómo + resultado cuantificado**, en orden cronológico inverso.

## Archivos

| Archivo | Para qué |
|---|---|
| `cv-arturo-grande-es.md` | Fuente editable en español. **Editá acá.** |
| `cv-arturo-grande-en.md` | Fuente editable en inglés. |
| `build.js` | Genera `.docx` y `.html` a partir de los `.md`. |
| `dist/CV_Arturo_Grande_ES.docx` | El que se sube a los portales. |
| `dist/CV_Arturo_Grande_EN.docx` | Ídem, en inglés. |
| `dist/CV_Arturo_Grande_ES.html` | Abrir en el navegador → Imprimir → Guardar como PDF. |

## Regenerar después de editar

```bash
npm install docx        # solo la primera vez
node cv/build.js
```

## Completar antes de enviar

Todo lo que está entre corchetes es un dato que hay que reemplazar:

- `[TELÉFONO]` — con código de país: +54 9 387 ...
- `[MM/AAAA]` — fechas de inicio y fin de cada rol (mes y año, formato consistente).
- `[X]` / `[N]` — números reales: %, cantidad de cuentas, personas, alumnos, horas.
- `[ROL ANTERIOR]` — el puesto previo a Eluter (los años de marketing y consultoría de marca).
  Si no lo vas a usar, borrá el bloque entero.
- `[Título de grado]`, `[Universidad]`, `[Año de egreso]` — sin esto, muchos ATS
  descartan por "sin educación cargada". Si no terminaste una carrera, poné la
  formación más alta que sí tengas (bootcamp, certificación, cursada incompleta con años).
- `[nivel: C1 / profesional]` — nivel real de inglés.
- Sección **Habilidades**: borrá toda tecnología que no puedas defender en una
  entrevista técnica. Un ATS te filtra por keyword, pero la entrevista la da una persona.

## Las 12 reglas ATS que este formato ya cumple

1. **Una sola columna.** Las plantillas de dos columnas se leen cruzadas y mezclan datos.
2. **Sin tablas, cuadros de texto ni cajas.** Los parsers las aplanan o las ignoran.
3. **Sin encabezado ni pie de página.** Muchos ATS descartan todo lo que va ahí:
   por eso el mail y el teléfono están en el cuerpo del documento.
4. **Sin fotos, logos ni íconos.** No aportan y rompen el parseo (además, en
   EE.UU. y UK la foto es un motivo de descarte por sesgo).
5. **Fuente estándar** (Calibri 10 pt). Nada de fuentes decorativas.
6. **Títulos de sección estándar y en el idioma del aviso**: Experiencia profesional,
   Educación, Habilidades. Nada de "Mi trayectoria" o "Lo que me mueve".
7. **Orden cronológico inverso**, con mes y año en todos los roles. Un hueco sin
   fechas se lee como gap.
8. **Viñetas simples** (`•`), no flechas, emojis ni guiones raros.
9. **Siglas + nombre completo**: "inteligencia artificial (IA)", "comercio exterior (COMEX)",
   "costo de adquisición (CAC)". El ATS busca las dos formas y no siempre las relaciona.
10. **Métricas en cada logro.** "USD 5M a USD 65M" pesa; "responsable de crecimiento" no.
11. **Links en texto plano** (`linkedin.com/in/arturo-grande`), no hipervínculos
    escondidos detrás de una palabra: si el parser tira el link, el texto sobrevive.
12. **Nombre de archivo con tu nombre**: `CV_Arturo_Grande_ES.docx`, no `cv_final_v3.docx`.

## Qué NO hacer

- **Keyword stuffing en blanco** (texto invisible con palabras clave). Los ATS
  modernos lo detectan y te marcan el perfil como fraudulento.
- **PDF exportado desde Canva/Figma o escaneado**: sale como imagen y el ATS lee cero.
  Si mandás PDF, que sea con texto seleccionable.
- **"Referencias a pedido"**: ocupa una línea y no aporta nada.
- **Objetivo personal genérico**. El perfil de arriba tiene que decir qué hacés y
  con qué resultado, no qué querés.

## Cómo adaptarlo a cada búsqueda (5 minutos por postulación)

1. Pegá el aviso y contá las palabras que se repiten (producto, growth, fintech,
   pagos, IA, B2B, SQL...).
2. Si esa palabra describe algo que realmente hiciste, tiene que aparecer
   **textual** en tu CV, preferentemente en el perfil o en una viñeta —
   no solo en la lista de habilidades.
3. Reordená las viñetas: la más relevante para ese aviso va primera.
4. Ajustá el perfil profesional (2-3 líneas) al puesto concreto.
5. Guardá como `CV_Arturo_Grande_[Empresa].docx`.

## Formato a subir

- **Portales de empresa (Workday, Greenhouse, Lever): `.docx`.** Es el formato
  que mejor parsean.
- **Mail a una persona / LinkedIn Easy Apply: PDF** (generado desde el `.html`
  o exportado desde Word), que se ve igual en todos lados.
- Nunca `.pages`, `.odt` ni imagen.
