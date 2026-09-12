# Setup local

El repo ignora `.claude/`, así que las skills no viajan por git. Dos comandos:

```bash
# Skills oficiales de Stellar (8 módulos: contratos, dapp, assets, data,
# standards, cross-chain, zk-proofs, agentic-payments)
git clone --depth 1 https://github.com/stellar/stellar-dev-skill /tmp/sds
mkdir -p .claude/skills
for d in /tmp/sds/skills/*/; do
  n=$(basename "$d")
  cp -r "$d" ".claude/skills/stellar-$n"
  sed -i "0,/^name: ${n}$/s//name: stellar-${n}/" ".claude/skills/stellar-$n/SKILL.md"
done
rm -rf /tmp/sds

# Skills de OpenZeppelin para contratos Soroban auditados
/plugin marketplace add OpenZeppelin/openzeppelin-skills
```

## Toolchain

```bash
rustup target add wasm32v1-none   # target de compilación Soroban
npm install @stellar/stellar-sdk  # cliente TS v14
```

Para el CLI, **usá el binario precompilado, no `cargo install`**: compilar desde
crates.io falla en un build script de `libdbus-sys` salvo que tengas
`libdbus-1-dev` instalado, y aun así tarda ~10 minutos.

```bash
V=28.0.0
curl -sSL -o cli.tgz "https://github.com/stellar/stellar-cli/releases/download/v${V}/stellar-cli-${V}-x86_64-unknown-linux-gnu.tar.gz"
tar xzf cli.tgz && sudo install -m755 stellar /usr/local/bin/stellar
stellar --version
```

En macOS: `brew install stellar-cli`.

Verificado end-to-end sin red: `stellar contract init`, `stellar contract build`
(compila a WASM) y `cargo test` funcionan los tres offline.

## MCP

`.mcp.json` ya define **Raven**, el MCP server oficial de Stellar (busca en docs
y datos de ecosistema en vivo). Requiere autenticación la primera vez:

```bash
claude mcp list    # dispara el login
```

Playground web: https://raven.stellar.buzz/playground

## Recursos

- Gotchas críticos y direcciones testnet → `CLAUDE.md` (se autocarga)
- 45 ideas con estimación de esfuerzo → `IDEAS.md`
- `llms.txt` de Stellar: https://developers.stellar.org/llms.txt
- Stella (bot oficial): ícono amarillo en developers.stellar.org, o `#stella-help` en Discord
- 400+ gotchas de DeFi: https://github.com/kaankacar/stellar-defi-gotchas

## Limitación del entorno remoto

Esta sesión de Claude Code en la nube tiene bloqueado el egress hacia
`*.stellar.org` y `raven.stellar.buzz`. Se puede escribir y compilar código,
pero **no tocar testnet ni usar Raven desde acá**. Todo lo que necesite red
Stellar hay que correrlo local.
