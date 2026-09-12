# 45 ideas — Argentina Builder Challenge (Genesis)

Criterio de armado: problema argentino real, construible en 2 semanas sobre
building blocks de Stellar que ya existen, y con una integración que tenga
sentido dentro del producto (no Stellar decorativo).

Convención: **[BAJO]** = se puede hacer sin escribir contrato propio (composición
sobre contratos existentes + TS). **[MEDIO]** = contrato Soroban simple.
**[ALTO]** = contrato no trivial o dependencia externa riesgosa.

---

## 01 · Pagos

1. **Cobro QR para comercios** — Feria/almacén cobra en USDC, liquidación al
   instante, sin posnet ni 3% de comisión. Bloque: pagos clásicos + SAC. **[BAJO]**
2. **Split de gastos grupales** — El asado, el Airbnb, el alquiler compartido.
   Quién debe qué, liquidado on-chain en un click. **[BAJO]**
3. **Payroll para equipos remotos** — CSV con 40 empleados → 40 pagos USDC con
   fees casi nulos. El caso de uso nativo de Stellar. **[BAJO]**
4. **Propinas con QR personal** — Mozos, deliverys, estacioneros. Cobran en dólar
   sin cuenta bancaria. **[BAJO]**
5. **Suscripciones recurrentes en USDC** — Autorización Soroban revocable: el
   comercio cobra hasta X por mes, el usuario corta cuando quiere. **[MEDIO]**
6. **Pagá en 3 partes sin tarjeta** — Cuotas con garantía en escrow, para gente
   sin acceso a crédito. **[MEDIO]**
7. **Link de cobro para freelancers** — Generás un link, el cliente del exterior
   paga, te llega USDC. Reemplaza el circuito PayPal/Payoneer. **[BAJO]**
8. **Caja chica con límites** — Sub-cuentas por empleado con tope de gasto y
   rendición automática. **[MEDIO]**
9. **Remesa a alguien sin wallet** — Mandás plata por link de WhatsApp; el que
   recibe crea la wallet al reclamar. **[MEDIO]**
10. **Pago contra recepción** — Dos pasos: el proveedor cobra recién cuando el
    comprador confirma que llegó la mercadería. **[MEDIO]**
11. **Paywall por artículo** — Micropago de USD 0.05 por nota. Imposible con
    tarjeta, trivial con Stellar. **[BAJO]**
12. **Cuotas de club de barrio** — Cobro recurrente para clubes, mutuales y
    escuelas, con transparencia de caja. **[BAJO]**

## 02 · DeFi & RWA

13. **Círculo de ahorro rotativo (la vaquita)** — Millones lo usan informalmente;
    el que administra puede desaparecer con el pozo. Contrato que custodia,
    ordena turnos y denomina en USDC. **[MEDIO]**
14. **Escrow de garantía de alquiler** — La garantía propietaria excluye a
    cualquiera sin pariente con inmueble, y el depósito en pesos se licúa.
    Trustless Work ya tiene el contrato deployado. **[BAJO]**
15. **Vault de yield con UX de plazo fijo** — Wrapper sobre DeFindex/Blend que
    esconde toda la jerga. "Poné plata, mirá cómo crece." **[BAJO]**
16. **Lotería no-loss** — Depositás, no perdés capital, el yield se sortea.
    (Ojo: si ya lo construiste antes, no califica para Genesis.) **[MEDIO]**
17. **Factoring de facturas PyME** — La PyME tokeniza la factura a 60 días y
    cobra hoy con descuento. Problema enorme y muy argentino. **[ALTO]**
18. **Crowdfunding por hitos** — Los fondos se liberan por etapa cumplida, no
    todo adelantado. Escrow multi-release. **[BAJO]**
19. **DCA automático** — Todas las semanas convierte un monto fijo. Disciplina
    de ahorro sin pensarlo. **[BAJO]**
20. **Préstamo entre conocidos** — Le prestás a un amigo con términos escritos
    on-chain. Resuelve el "che, ¿cuándo me devolvés?". **[MEDIO]**
21. **Seguro paramétrico agro** — Si llueve menos de X mm, paga solo. Oráculo
    Reflector. Mercado argentino gigante. **[ALTO]**
22. **Tokenización de granos** — Warrants de soja/trigo como activo digital
    transferible. El campo argentino ya opera en "dólar soja". **[ALTO]**
23. **Ahorro con meta y candado** — "Junto para el viaje": penalidad por retiro
    anticipado, que es justamente lo que hace que funcione. **[MEDIO]**
24. **Cuenta conjunta con yield repartido** — Pareja o socios ahorran juntos,
    el rendimiento se reparte por proporción aportada. **[MEDIO]**

## 03 · Herramientas financieras locales

25. **Billetera dólar-primero sin jerga** — Cero mención a "blockchain", "gas" o
    "seed phrase". Passkeys. Tu vieja la puede usar. **[MEDIO]**
26. **Alcancía digital para chicos** — Los viejos cargan, el pibe ve crecer,
    con control parental sobre el retiro. **[MEDIO]**
27. **Sueldo que no se licúa** — Cobrás en pesos, se convierte solo a USDC el
    día que entra. El problema #1 del asalariado argentino. **[BAJO]**
28. **Fondo de emergencia con reglas** — Bloqueado salvo condición explícita.
    Te protege de vos mismo. **[MEDIO]**
29. **Ahorro por redondeo** — Cada compra redondea para arriba y la diferencia
    va a dólares. Ahorrás sin notarlo. **[BAJO]**
30. **Cuenta para changas** — El 40% informal no tiene comprobante de ingresos.
    Historial de cobros verificable = acceso a alquiler y crédito. **[MEDIO]**
31. **Historial crediticio on-chain** — Score construido con cumplimiento de
    pagos reales, portable entre plataformas. **[MEDIO]**
32. **Presupuesto familiar multi-firma** — Gastos grandes requieren dos firmas.
    Cuentas claras conservan la amistad. **[MEDIO]**
33. **Aguinaldo programado** — Ahorro forzado mensual que se libera en junio y
    diciembre. **[BAJO]**
34. **Comparador de tipo de cambio ejecutable** — No solo te muestra dónde
    conviene: ejecuta. **[BAJO]**
35. **Alquiler mensual automático** — Débito en USDC con recibo verificable para
    ambas partes. Mata la discusión de "ya te pagué". **[BAJO]**
36. **Caja transparente de cooperativa** — Mutual o cooperativa de barrio con
    entradas y salidas auditables por los socios. **[BAJO]**

## 04 · Integración abierta

37. **MCP server de pagos Stellar** — Que un agente AI pueda mover plata con
    permisos acotados. El skill `stellar-agentic-payments` cubre esto. **[MEDIO]**
38. **Agente que paga APIs solo** — x402: recibe 402, firma auth entry, reintenta.
    Stellar tiene soporte oficial. **[MEDIO]**
39. **KYC portable** — Verificás identidad una vez, la reusás en N servicios sin
    volver a mandar el DNI. **[ALTO]**
40. **Recibos verificables** — Comprobante de pago con prueba criptográfica.
    Útil para alquiler, changas, servicios. **[BAJO]**
41. **Donaciones trazables para ONGs** — El donante ve exactamente en qué se
    gastó su plata. **[BAJO]**
42. **Fidelidad interoperable de barrio** — Los puntos del kiosco sirven en la
    panadería. Red de comercios chicos. **[MEDIO]**
43. **Reputación portable de marketplace** — Tu historial de vendedor deja de
    ser rehén de una plataforma. **[MEDIO]**
44. **Bounties con pago al merge** — Se paga solo cuando el PR se mergea.
    Integración GitHub + escrow. **[MEDIO]**
45. **Tickets antifraude** — Entradas para eventos y boliches imposibles de
    duplicar, con reventa controlada. **[MEDIO]**

---

## Filtro para elegir

Tres preguntas, en este orden:

1. ¿Podés nombrar cinco personas concretas que tengan este problema hoy?
   Si no, la "validación del problema" se cae en el pitch.
2. ¿Funciona la demo sin ningún permiso, API key o KYC que dependa de que
   alguien te conteste un mail? Si no, no llegás al 27.
3. ¿Stellar es necesario o decorativo? El jurado evalúa si "la integración
   tiene sentido dentro del producto".

Las que pasan las tres con más margen: **14 (escrow alquiler)**, **13 (vaquita)**,
**27 (sueldo que no se licúa)**, **30 (cuenta para changas)**, **3 (payroll)**.
