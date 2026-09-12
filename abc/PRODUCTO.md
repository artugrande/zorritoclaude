# Ronda — ahorro rotativo multi-cadena en USDT0

**Track:** Genesis · **Categoría:** Herramientas financieras locales
**Una línea:** La vaquita de siempre, pero el contrato guarda la plata y cada
uno aporta desde la cadena donde ya tiene sus dólares.

---

## El problema

La ronda de ahorro rotativo —vaquita, rueda, tanda— es el instrumento
financiero informal más usado de Latinoamérica. Un grupo aporta un monto fijo
por período y cada período uno se lleva el pozo entero, por turnos.

Funciona porque resuelve algo que el banco no: te da acceso a un monto grande
sin crédito, sin historial y sin garantía. Falla siempre por lo mismo:

1. **Alguien tiene que custodiar el pozo**, y ese alguien puede desaparecer.
2. **Alguien tiene que perseguir a cada miembro** todos los meses.
3. **En pesos, la ronda se licúa**: a 10 meses, el último turno cobra bastante
   menos de lo que aportó el primero.
4. Nadie construye historial: cumplir 10 meses seguidos no te sirve para nada
   después.

## Por qué no existe la versión digital

La versión cripto choca con una barrera antes del segundo miembro: **todos
tienen que estar en la misma cadena**. El argentino promedio que ahorra en
dólares los tiene en USDT sobre Tron o en un exchange. Pedirle que migre a otra
red para entrar a la vaquita del grupo de WhatsApp mata el producto ahí mismo.

En los 812 proyectos del ecosistema Stellar, la única ronda de ahorro es
**LulPay**, en Uganda, para refugiados. En Latinoamérica no hay ninguna.

## Por qué USDT0 es necesario, no decorativo

USDT0 elimina exactamente esa barrera. Es USDT nativo sobre el estándar OFT de
LayerZero, conectando Stellar con 100+ cadenas, sin token wrappeado ni pool.

Y tiene una propiedad que hace que este producto sea posible y antes no:

> **Un destinatario `C…` no necesita trustline.** Los balances SAC de contratos
> viven en storage de contrato, no en trustline.

El contrato de la ronda recibe aportes **directo desde cualquier cadena, sin
setup previo**. Uno aporta desde Tron, otro desde BSC, otro ya está en Stellar.
Ninguno migra nada. El contrato custodia, ordena los turnos y paga.

Eso no se puede hacer con USDC nativo de Circle sin meter CCTP encima, y no se
puede hacer en ninguna cadena donde la fee por transferencia sea un porcentaje
sensible de un aporte de 20 dólares.

---

## Alcance de dos semanas

### Contrato Soroban

```
crear_ronda(miembros, monto_turno, periodo, orden) -> ronda_id
registrar_intencion(ronda_id, miembro, monto)      -> monto_etiquetado
acreditar(ronda_id, miembro, monto)                 aporte nativo en Stellar
ejecutar_turno(ronda_id)                            paga al titular del turno
estado(ronda_id)                                    quién pagó, de quién es el turno
```

### Atribución: el problema real

Cuando llegan USDT0 desde Tron, el evento `oft_received` trae
`["oft_received", guid, src_eid, to]` y `amount_received_ld`. **No trae de forma
confiable quién de tus miembros pagó.**

`compose_msg` existe en `SendParam` y el endpoint soporta mensajes compuestos,
pero no está verificado que el deployment de USDT0 los enrute — y sin testnet de
USDT0 no se puede probar. **No diseñar contra eso.**

La solución que sí funciona, y que los bancos usan hace décadas: **monto único
por ventana**.

1. El miembro declara la intención en la app: "aporto 20 desde Tron"
2. El contrato le devuelve un monto etiquetado: `20.000047`
3. Manda exactamente ese monto
4. El indexer ve el `oft_received`, machea el monto contra la intención
   pendiente y acredita al miembro. El `guid` queda como auditoría.

**Cuidado con el decimal.** Los decimales locales son 7 y los compartidos 6: el
OFT recorta el séptimo antes de armar el mensaje. **La etiqueta va en el sexto
decimal o más arriba** — nunca en el séptimo, que no viaja.

### Morosos

Un miembro que no aporta no puede bloquear la ronda entera. Regla mínima y
defendible: el turno paga **lo que efectivamente se juntó**, el incumplimiento
queda registrado on-chain, y el que falla pierde su turno futuro. Las
obligaciones de los que quedan se recalculan.

Eso además produce, como subproducto, un historial de cumplimiento verificable
— que en el ecosistema tiene un solo proyecto (Trustful).

### Lo que se corta

- **Yield con Blend mientras el pozo está quieto.** Tentador y encaja, pero suma
  superficie de fallo y trustlines. Solo si sobra tiempo en la semana 2.
- Rondas con orden por subasta (el que más descuento acepta cobra antes).
- App nativa. Web mobile-first alcanza.

---

## Plan, contra los checkpoints reales

| Cuándo | Qué |
|---|---|
| **12–17/09** | Contrato + tests unitarios. Todo en **testnet con USDC**, que sí tiene testnet |
| **21/09 · checkpoint 1** | Contrato funcionando: crear, aportar, ejecutar turno, morosos |
| **21–24/09** | Frontend mobile-first + indexer de `oft_received` |
| **24/09 · checkpoint 2** | Flujo completo en testnet, pata USDT0 con `quote_oft` en vivo |
| **25–26/09** | Transferencia real de polvo en mainnet, grabada. Pitch |
| **27/09** | Submission |

**El ensayo de USDT0 no es opcional ni es al final.** Como no hay testnet, la
única prueba de que el flujo anda es una transferencia real de centavos en
mainnet. Hacerla la primera semana, no la última.

## Guards que no se negocian

1. **Verificar que el contrato existe antes de cada envío cross-chain.** La
   existencia se lee en la *entrega*, no en el envío. Si no está desplegado
   cuando llega el mensaje, el OFT acredita un `G…` cuya clave no tiene nadie y
   los fondos son irrecuperables — con el origen ya habiendo quemado.

   ```bash
   stellar ledger entry fetch contract-data --contract "$RONDA" --instance \
     --output json-formatted --network mainnet
   ```

2. **TTL con margen.** Si la instancia se archiva entre el envío y la entrega,
   mismo desenlace. Extender dejando margen para finalidad del origen,
   verificación de DVNs y latencia del executor.

3. **Destinatario como payload crudo de 32 bytes**, nunca el strkey, nunca con
   version byte ni checksum. Esto **no se copia de CCTP**, que sí lleva strkey
   como hook data UTF-8.

4. **Quote con piso 0 primero**, mostrar `amount_received_ld` al usuario,
   re-quotear con su piso justo antes de mandar.

---

## Qué contesta cada criterio del jurado

- **Validación del problema** — La ronda informal existe y se usa hoy, a mano,
  en millones de grupos. No hay que inventar demanda.
- **Foco de negocio** — Cada ronda trae 4 a 10 usuarios de una, por invitación
  de alguien que ya confían. La distribución es el producto.
- **Foco de producto** — El usuario no migra de cadena, no aprende qué es una
  trustline y no compra nada: usa los dólares que ya tiene.
- **Ejecución técnica** — USDT0 no es un logo en el slide: sin recepción
  multi-cadena sin trustline, este producto no existe. Y el guard de entrega
  demuestra que entendimos un modo de falla que quema fondos.
