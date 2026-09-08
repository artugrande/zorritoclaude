# CV ATS-friendly — Arturo Grande (English)

Una página, columna única, en inglés. Pensado para pasar los filtros ATS
(Workday, Greenhouse, Lever, SmartRecruiters, Taleo) y siguiendo la estructura de
las guías de Harvard OCS: viñetas de **verbo de acción + qué + cómo + resultado
cuantificado**, en orden cronológico inverso.

> **Estado:** falta reemplazar los marcadores `[FECHA_*]` y `[EDUCACION]` en
> `cv-arturo-grande-en.md`. Son los únicos datos que no se pueden sacar de fuentes
> públicas. Una vez completados, `node cv/build.js` y queda definitivo.

## Archivos

| Archivo | Para qué |
|---|---|
| `cv-arturo-grande-en.md` | Fuente editable. **Editá acá.** |
| `build.js` | Genera `.docx` y `.html` a partir del `.md`. |
| `dist/CV_Arturo_Grande.docx` | El que se sube a los portales. |
| `dist/CV_Arturo_Grande.html` | Abrir en el navegador → Imprimir → Guardar como PDF. |

```bash
npm install docx        # solo la primera vez
node cv/build.js
```

El layout está calibrado para entrar en **una sola página**. Si agregás
contenido, verificá abriendo el `.html` e imprimiendo: si pasa a dos páginas,
sacá una viñeta antes de bajar el tamaño de letra.

## Las 12 reglas ATS que este formato ya cumple

1. **Una sola columna.** Las plantillas de dos columnas se leen cruzadas y mezclan datos.
2. **Sin tablas, cuadros de texto ni cajas.** Los parsers las aplanan o las ignoran.
3. **Sin encabezado ni pie de página.** Muchos ATS descartan todo lo que va ahí:
   por eso el mail y el teléfono están en el cuerpo del documento.
4. **Sin fotos, logos ni íconos.** No aportan y rompen el parseo (además, en
   EE.UU. y UK la foto es motivo de descarte por sesgo).
5. **Fuente estándar** (Calibri 10 pt). Nada decorativo.
6. **Títulos de sección estándar y en inglés**: Professional Experience,
   Education, Skills. Nada de "My journey".
7. **Orden cronológico inverso**, con mes y año en todos los roles. Un hueco sin
   fechas se lee como gap.
8. **Viñetas simples** (`•`), no flechas, emojis ni guiones raros.
9. **Siglas + nombre completo**: "artificial intelligence (AI)",
   "international trade (COMEX)", "Developer Relations (DevRel)". El ATS busca
   las dos formas y no siempre las relaciona.
10. **Métricas en los logros.** "USD 5M to USD 65M" pesa; "responsible for growth" no.
11. **Links en texto plano** (`linkedin.com/in/arturo-grande`), no hipervínculos
    escondidos detrás de una palabra: si el parser tira el link, el texto sobrevive.
12. **Nombre de archivo con tu nombre**: `CV_Arturo_Grande.docx`, no `cv_final_v3.docx`.

## Qué NO hacer

- **Keyword stuffing en blanco** (texto invisible con palabras clave). Los ATS
  modernos lo detectan y marcan el perfil como fraudulento.
- **PDF exportado desde Canva/Figma o escaneado**: sale como imagen y el ATS lee cero.
  Si mandás PDF, que sea con texto seleccionable.
- **"References available upon request"**: ocupa una línea y no aporta nada.
- **Objetivo personal genérico.** El summary dice qué hacés y con qué resultado,
  no qué querés.

## Cómo adaptarlo a cada búsqueda (5 minutos por postulación)

1. Pegá el aviso y contá las palabras que se repiten (product, growth, fintech,
   payments, AI, B2B, SQL...).
2. Si esa palabra describe algo que realmente hiciste, tiene que aparecer
   **textual** en el CV, preferentemente en el summary o en una viñeta —
   no solo en la lista de skills.
3. Reordená las viñetas: la más relevante para ese aviso va primera.
4. Ajustá el Professional Summary (2-3 líneas) al puesto concreto.
5. Guardá como `CV_Arturo_Grande_[Empresa].docx`.

## Formato a subir

- **Portales de empresa (Workday, Greenhouse, Lever): `.docx`.** Es el formato
  que mejor parsean.
- **Mail a una persona / LinkedIn Easy Apply: PDF** (generado desde el `.html`
  o exportado desde Word), que se ve igual en todos lados.
- Nunca `.pages`, `.odt` ni imagen.
