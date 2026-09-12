# USDT0 en Stellar — qué habilita y cómo construirlo sin perder fondos

USDT0 es USDT movido sobre el estándar OFT de LayerZero. No hay token wrappeado
ni pool. En Stellar es un **activo clásico** con issuer bloqueado cuyo admin de
SAC es un contrato. El endpoint de LayerZero en Stellar salió a mainnet en julio
de 2026 y conecta con 100+ cadenas.

## La restricción que decide el proyecto

> **No hay deployment de USDT0 en testnet** (verificado 2026-08-27 contra la
> página de deployments de USDT0).

No se puede ensayar un round-trip de USDT0. El camino de ensayo es:

1. Simulación read-only con `quote_oft` y `quote_send` (gratis, mainnet)
2. Una transferencia real de **polvo** en mainnet — esa transferencia *es* la
   prueba de que el flujo anda
3. Hacerla **antes** de mover el saldo de cualquier usuario

Para una hackathon de dos semanas esto significa: el producto se construye y
testea en testnet con USDC, y la pata USDT0 se demuestra con quotes en vivo más
una transferencia real de centavos grabada para el video.

## Direcciones (mainnet)

| Superficie | Dirección |
|---|---|
| Activo clásico | `USDT0:GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q` |
| SAC | `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` |
| OFT | `CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6` |
| SAC manager (mint/burn) | `CA3GUWLOS3QKN6WNRAELSUDSKLDTVTWEDJ3KLGAJG3SIWGA5L3KZYWGJ` |

EID de Stellar: **`30600`** (mainnet) · `40600` (testnet).

Verificar la SAC por derivación antes de confiar en nada:

```bash
stellar contract id asset --asset USDT0:GATISXX6... --network mainnet
# debe devolver CBSJZEIO...
```

`USDT0` es un código de 5 caracteres (`credit_alphanum12`): **el código solo no
identifica nada**, siempre va con el issuer. Y el issuer no publica
`home_domain`, así que **no hay `stellar.toml`** — cualquier validación que
dependa de SEP-1 falla sobre un activo legítimo y vivo.

## Los cinco modos de falla que cuestan fondos

1. **Trustline.** Un destinatario `G…` necesita trustline de USDT0 *antes* de
   que llegue nada. Es la falla de entrada más común. Un destinatario `C…` no
   necesita ninguna — los balances SAC de contratos viven en storage, no en
   trustline.

2. **Encoding del destinatario.** El mensaje lleva un payload **crudo de 32
   bytes**. Hay que decodificar el strkey y mandar **solo su payload**: la clave
   pública Ed25519 para una cuenta `G…`, el hash del contract ID para un `C…`.
   Nunca el string del strkey, nunca con el version byte ni el checksum de 2
   bytes. Cualquiera de esos le da al OFT 32 bytes distintos, que igual resuelve:
   el crédito cae en una dirección que no controlás.
   **Esto no se copia de CCTP** — CCTP lleva el strkey como hook data UTF-8;
   LayerZero no.

3. **El contrato tiene que existir en la ENTREGA, no en el envío.** Si el `C…`
   no está desplegado cuando llega el mensaje, el OFT lee los mismos 32 bytes
   como cuenta Ed25519 y acredita un `G…` cuya clave secreta no tiene nadie. Esa
   cuenta nunca va a poder firmar un `changeTrust`, así que nunca va a tener
   trustline, y la entrega falla para siempre — con la cadena de origen ya
   habiendo quemado los tokens. Verificar la instancia inmediatamente antes:

   ```bash
   stellar ledger entry fetch contract-data --contract "$RECIPIENT" --instance \
     --output json-formatted --network mainnet
   ```

4. **TTL.** Si la instancia se archiva entre el envío y la entrega, aplica el
   mismo fallback a `G…`. Extender con margen para finalidad del origen,
   verificación de DVNs y latencia del executor.

5. **Decimales: 7 locales, 6 compartidos.** El OFT recorta el resto antes de
   armar el mensaje. Sin fee en la ruta, el polvo **se queda en tu cuenta** (no
   se pierde, pero tampoco viaja); con fee, se absorbe en el fee. Nunca
   hardcodear: leer `effective_fee_bps(dst_eid)`.

Extra: las direcciones **muxed (`M…`) no entran** — decodifican a 40 bytes y el
OFT lee 32. Cada sub-cuenta necesita su propio `G…`.

## Regla de quoting

Nunca descubrir una ruta con un piso de slippage real: `quote_oft` y `quote_send`
asertan `amount_received_ld >= min_amount_ld` y panican con `SlippageExceeded`,
así que una ruta cara es indistinguible de una rota.

1. Quotear con `min_amount_ld = 0` para descubrir
2. Mostrarle al usuario `amount_received_ld` — ese, no su input, es la verdad
3. Re-quotear con el piso del usuario inmediatamente antes de `send`

Dos fees en dos denominaciones: `min_amount_ld` es USDT0 en 7 decimales, el fee
de mensajería es XLM en stroops. Nunca cruzar un número de una a la otra.

## Para acreditar del lado Stellar

Nada del lado Stellar necesita firma del destinatario. Se escucha el evento
`oft_received` sobre el OFT — topics `["oft_received", guid, src_eid, to]`, y el
data lleva `amount_received_ld`.

## Qué habilita, en términos de producto

USDT0 no es una categoría de producto: es un **rail de fondeo**.

Lo que cambia para un producto argentino es que **el usuario ya tiene los
dólares** — en Tron, en Binance, en la cadena que sea. Antes, fondear una app de
Stellar en Argentina exigía un anchor ARS, y no hay ninguno con acceso
self-service documentado. USDT0 saca al anchor del camino crítico: el saldo que
la persona ya tiene es el on-ramp.

Y un detalle arquitectónico que vale oro: **un contrato `C…` recibe USDT0 sin
trustline**, desde cualquiera de las 100+ cadenas. Un contrato de ahorro grupal
puede recibir aportes de miembros que están cada uno en una cadena distinta, sin
que ninguno tenga que migrar primero. Eso es nativo de USDT0 y no se puede hacer
con USDC circle-nativo sin CCTP.

El precio de ese detalle es el modo de falla 3: el contrato tiene que estar vivo
y no archivado cuando llega el mensaje, o los fondos quedan irrecuperables.
