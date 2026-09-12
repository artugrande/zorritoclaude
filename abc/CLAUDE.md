# Argentina Builder Challenge — proyecto Stellar

Hackathon BAF × Stellar. Track Genesis (proyecto nuevo desde cero).
Kickoff 12/09/2026 · Checkpoints 21 y 24/09 · Submission final 27/09.

## Stack

- Contratos: Rust + `soroban-sdk`, target `wasm32v1-none`
- Cliente: `@stellar/stellar-sdk` v14+ (TypeScript)
- Red: Testnet

## Reglas de SDK que el modelo suele equivocar

El SDK v14 renombró el namespace. Escribí siempre:

```ts
import { rpc, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
const server = new rpc.Server('https://soroban-testnet.stellar.org');
```

- `rpc`, NO `SorobanRpc` (el modelo va a escribir v13 por defecto)
- `rpc.assembleTransaction()`, no el helper viejo
- Stellar Wallets Kit v2 usa `StellarWalletsKit.build(config)`, no el constructor v1
- Usar `Networks.TESTNET` / `Networks.PUBLIC`, nunca un passphrase hardcodeado
  (un mismatch da `tx_bad_auth`, que parece error de red pero no lo es)

## Ciclo de transacción obligatorio

Saltear la simulación produce fallos crípticos. Siempre:

```ts
const sim = await server.simulateTransaction(tx);
const assembled = rpc.assembleTransaction(tx, sim);
const sent = await server.sendTransaction(assembled);
// sendTransaction devuelve PENDING, NO éxito. Hay que pollear:
const result = await server.pollTransaction(sent.hash, { attempts: 60 });
```

Todo va por `rpc.Server`: pagos clásicos, ChangeTrust, creación de cuenta,
sequence numbers. No usar Horizon. Rutear al servidor equivocado falla en silencio.

## Storage TTL

Los TTL de storage expiran **en silencio**: las lecturas devuelven
missing-value sin warning. Extender proactivamente cuando queden ~100 ledgers;
apuntar a ~518400 ledgers (~30 días).

## USDC testnet: issuers incompatibles

Cada protocolo mintea su propia variante. Elegir mal = swaps que fallan en silencio.

| Issuer | Dirección | Usado por |
|---|---|---|
| Circle (estándar) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | Soroswap, mayoría |
| Blend | `GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56` | Blend |

Verificar cuál espera el protocolo antes de escribir la primera línea.

## Contratos testnet

RPC: `https://soroban-testnet.stellar.org`

| Protocolo | Dirección |
|---|---|
| Blend Pool Factory V2 | `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6` |
| DeFindex Factory | `CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32` |
| Soroswap Router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Trustless Work (escrow multi-release) | `CB7EYMEHZI3UWS3EHNOUI55OD6X5FLMV537NEUQ6EWO677N6B6XSBP25` |

## Gotchas por protocolo

**Trustlines primero, siempre.** Sin trustline: `op_no_destination` o no-op
silencioso. Blend falla en silencio si depositás sin trustline previa.
Trustless Work: cada rol necesita trustline con la dirección del **issuer (G...)**,
no con el contract ID.

**Soroswap**: montos en `BigInt(...)` (no `parseFloat`), slippage como string
en basis points (`'50'`). El paquete es `@soroswap/sdk` con scope — el
`soroswap-sdk` sin scope está desactualizado.

**DeFindex**: endpoint `/vault/` singular; query param `?from=` (no `?user=`);
montos como array `{"amounts":[1000000]}`; éxito es HTTP 201, no 200. Marcar
`@defindex/sdk` como `serverExternalPackages` en `next.config.ts`. Sus errores
son objetos planos, no instancias de `Error`. **La API testnet está caída** —
los contratos andan, la capa HTTP no.

**Freighter**: no importar estáticamente en Next.js (usa globals de browser,
rompe en SSR) — import dinámico dentro de async. En v6 `signTransaction`
devuelve un objeto: usar `result.signedTxXdr`, no `result`. Envolver las
llamadas con timeout: si la extensión no está instalada, cuelgan para siempre.

**Passkeys / WebAuthn**: `rpId` tiene que ser dominio. Las IP se rechazan.
En local forzar `'localhost'`.

**Activos clásicos en Soroban**: XLM/USDC necesitan SAC deployado antes de
poder depositarse en un protocolo Soroban.

## Contexto Argentina

No hay camino self-service documentado para anchors ARS (ARST/Settle, Anclap
existen pero sin sandbox público verificado). **No poner un anchor fiat en el
camino crítico.** Construir sobre USDC y dejar el borde fiat mockeado u opcional.

## Criterios de evaluación

Validación del problema · Foco de negocio · Foco de producto · Ejecución técnica.
Explícito del reglamento: *no* gana la solución técnicamente más compleja, sino
la que resuelve un problema real de forma útil, clara y ejecutable.
