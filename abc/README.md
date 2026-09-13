# Ronda

Ahorro rotativo multi-cadena en USDT0 sobre Stellar.
La vaquita de siempre, pero el contrato guarda la plata y cada uno aporta desde
la cadena donde ya tiene sus dólares.

**Argentina Builder Challenge** (BAF × Stellar) · Track Genesis
Hackathon 12 → 26/09/2026 · Checkpoints 21 y 24/09 · Submission 27/09

---

## Empezá acá

| Leé esto | Para |
|---|---|
| **[PRODUCTO.md](PRODUCTO.md)** | Qué construimos, alcance de 2 semanas, plan contra checkpoints |
| **[USDT0.md](USDT0.md)** | Direcciones mainnet y los 5 modos de falla que queman fondos |
| **[CLAUDE.md](CLAUDE.md)** | Gotchas de Soroban y direcciones testnet — se autocarga en Claude Code |
| [GAPS.md](GAPS.md) | Por qué esta idea: análisis de 812 proyectos del ecosistema |
| [EVM-GAPS.md](EVM-GAPS.md) | 50 primitivas EVM vs. Stellar |
| [IDEAS.md](IDEAS.md) | Las otras 44 ideas que descartamos |
| [SETUP.md](SETUP.md) | Toolchain y MCP |

## Estado

- ✅ Investigación cerrada, producto definido
- ✅ Workspace Soroban scaffoldeado y compilando a WASM
- ✅ 8 skills oficiales de Stellar incluidas en `.claude/skills/`
- ⬜ Contrato `ronda` — `contracts/ronda/src/lib.rs` es todavía el hello-world
- ⬜ Indexer de `oft_received`
- ⬜ Frontend
- ⬜ **Ensayo de USDT0 en mainnet** ← hacelo primero, ver abajo

## Convertirlo en su propio repo de GitHub

Esta carpeta está preparada para vivir sola. Desde tu máquina:

```bash
# 1. Traete el branch donde quedó todo
git clone https://github.com/artugrande/zorritoclaude.git
cd zorritoclaude
git checkout claude/intelligent-edison-ma2om1

# 2. Extraé abc/ como repo independiente
cp -r abc ../ronda
cd ../ronda
rm -rf node_modules target
git init && git add -A && git commit -m "Ronda: initial import"

# 3. Creá el repo en GitHub y pusheá
gh repo create ronda --private --source=. --push
```

A partir de ahí, `claude` desde `../ronda` levanta `CLAUDE.md` y las 8 skills
de Stellar solo.

## Setup local

```bash
rustup target add wasm32v1-none
npm install
stellar contract build && cargo test
```

Para el CLI usá el binario precompilado, **no `cargo install`** (falla en un
build script de `libdbus-sys`). Ver [SETUP.md](SETUP.md).

## Lo primero que hay que hacer

**No hay deployment de USDT0 en testnet.** La única prueba de que el flujo
cross-chain anda es una transferencia real de centavos en mainnet. Hacela la
primera semana, no la última — si falla el 26 no hay proyecto.

Todo lo demás (contrato, turnos, morosos) se construye y testea en testnet con
USDC, que sí tiene testnet.

## Nota sobre el entorno

Estos documentos se produjeron en una sesión remota de Claude Code con el
egress bloqueado hacia `*.stellar.org` y `raven.stellar.buzz`. Se pudo escribir,
compilar y testear contratos, pero **nada de esto se ejecutó contra la red**.
Las direcciones y el comportamiento del OFT salen de la skill oficial
`stellar-cross-chain`, no de una verificación propia contra mainnet.
Verificá la derivación de la SAC antes de mover fondos:

```bash
stellar contract id asset --asset USDT0:GATISXX6... --network mainnet
# debe devolver CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF
```
