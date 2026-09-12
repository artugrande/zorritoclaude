# Qué existe y qué falta en Stellar — análisis de huecos

**Fuente:** `lumenloop/stellar-ecosystem-db`, 812 proyectos, reporte
autogenerado el 12/09/2026 (mismo día del kickoff). 674 financiados por SCF.
Método: búsqueda por keywords sobre título + descripción + tags de cada
proyecto, con verificación manual de los resultados en cero.

Composición: 356 Applications · 152 Developer Tooling · 143 Financial
Protocols · 130 Infrastructure & Services · 31 Education & Community.

---

## Saturado — no construyas acá

| Espacio | Proyectos | Nota |
|---|---|---|
| Wallets | 152 | El espacio más poblado del ecosistema, lejos |
| QR / merchant / payment gateway | 57 | StellarPay, TERWA, Wirex Pay, GetBlockCard |
| Vaults y yield | 28 | Upshift, Bridge, Ballast Re, Backyard |
| Payroll y pagos masivos | 26 | PayZoll, CodeLnPay, Tumbl, ElementPay |
| Invoicing / link de cobro freelance | 22 | Bitwage, Meru, Gearup |
| Donaciones y ONGs | 16 | KindFi, Idunu, Tracee, xcapit |
| Crowdfunding | 10 | Vitreous, The Signal |

Tags más frecuentes: Payments (150), DeFi (138), Security (86),
Cross-Border Payments (84), Stablecoins (69), On-Off Ramp (55).

## Argentina ya tiene 24 proyectos

Es el país de Latam con más proyectos en el ecosistema (por delante de
Brasil con 18 y Chile con 14). Varios matan ideas obvias:

| Proyecto | SCF | Qué hace | Idea que mata |
|---|---|---|---|
| **Lemon, Ripio, Bexo, Airtm, xcapit** | varios | Billeteras USDC para Latam | Billetera dólar-primero |
| **Piggy Wallet** | r41 · $112k | App de finanzas familiares, chicos ahorran | Alcancía para chicos |
| **Depay** | r24 · $42k | "Pagos cripto en economías con inflación" | Sueldo que no se licúa |
| **SGF Solutions** | r28 · $30k | Cambia USDC↔ARS y deposita | Comparador de cambio |
| **Anclap** | r26 · $572k | Anchor FIAT↔cripto | Cualquier cosa de rails ARS |
| **Comunitaria** | r34 · $49k | Monedas comunitarias en Soroban | Caja de cooperativa |
| **Pluto Loans** | r15 · $141k | Préstamos autopagables con yield futuro | Productos de yield adelantado |

Fuera de Argentina: **DevAsign** (r39) ya automatiza payouts de bounties, y
**REAPP** (r43, "Real Agentic Payment Protocol") está construyendo la capa de
autorización para comercio agéntico — o sea, x402.

---

## Huecos reales (verificados en cero)

Estos devolvieron **cero resultados** sobre 812 proyectos, y verifiqué cada uno
con términos alternativos antes de darlos por vacíos.

| Hueco | Hits | Lo más cercano |
|---|---|---|
| **Ahorro premiado / lotería no-loss** | **0** | nada — los 2 hits de "prize" son gaming |
| **Ahorro por redondeo (round-up)** | **0** | nada |
| **DCA / inversión recurrente automática** | **0** | nada |
| **Depósito de garantía de alquiler** | **0** | Mica (México) hace escrow de compraventa, no alquiler |
| **Split de gastos consumer** | **0** | SoroSplits (Turquía) reparte revenue B2B, no gastos entre amigos |
| ROSCA / vaquita en Latam | 1 | LulPay, pero es Uganda y para refugiados |
| Prueba de ingresos para informales en Latam | 1 | Kasi Money, pero es Sudáfrica |
| Score crediticio on-chain | 1 | Ballast Re, y es reaseguro |
| Reputación portable | 1 | Trustful |
| Recibos verificables | 1 | Hurupay |
| Micropagos / paywall | 1 | Benkiko |
| Ticketing | 1 | Fewticket |
| BNPL / cuotas | 1 | Lumen Later |

### El patrón

Stellar tiene **143 Financial Protocols** y 33 proyectos con tag *Yield*: la
infraestructura de rendimiento está resuelta y sobra. Lo que no existe es
**producto de ahorro con mecánica conductual** — ahorro premiado, redondeo,
DCA, candados por meta, rondas rotativas. Cuatro de los cinco ceros absolutos
caen en ese clúster.

Es el hueco más grande y más coherente del ecosistema: hay dónde poner la
plata a rendir, pero nadie construyó las razones psicológicas para que la
gente la ponga.

El segundo patrón: **verticales vacías sobre infra que ya existe**. Trustless
Work (Costa Rica) vende escrow-as-a-service sobre Soroban y nadie construyó
encima la vertical de depósitos de alquiler. Es la forma ideal para dos
semanas: la parte difícil ya está deployada, vos construís el producto.

---

## Reordenamiento de las 45

**Muertas** — ya existe alguien financiado haciéndolo:
25 (billetera dólar), 26 (alcancía chicos), 44 (bounties), 3 (payroll),
1 (QR comercios), 15 (vault yield), 7 (link de cobro), 41 (donaciones).

**Ocupadas por argentinos** — competís de frente en tu propio mercado:
27 (sueldo no se licúa → Depay), 34 (cambio → SGF), 36 (cooperativa →
Comunitaria).

**La frontera caliente pero con dueño**: 38 (x402) — REAPP entró en r43.
Todavía hay lugar para aplicaciones encima, no para la capa de autorización.

**Los huecos que quedan**, ordenados por cuán defendible es el pitch:

1. **14 · Escrow de depósito de alquiler** — cero competencia, infra lista
   (Trustless Work), problema argentino verificable, y la licuación del
   depósito en pesos es un argumento que ningún jurado discute.
2. **13 · Ronda de ahorro (vaquita)** — cero en Latam, cero dependencias
   externas, y es la mecánica de ahorro informal más usada del continente.
3. **29 + 19 · Ahorro por redondeo con DCA** — dos ceros absolutos que son
   el mismo producto. Nadie en 812 proyectos lo construyó.
4. **2 · Split de gastos** — cero consumer, y es el caso de uso que más
   naturalmente justifica micro-pagos con fees de Stellar.
5. **30 · Prueba de ingresos para informales** — el único referente está en
   Sudáfrica; el 40% informal argentino no tiene comprobante de ingresos.

**16 (lotería no-loss) es un cero absoluto y sabés construirlo** — pero
Genesis prohíbe usar código propio anterior al kickoff. Sería escribirlo de
nuevo desde cero en Rust. El hueco es real; el costo, también.
