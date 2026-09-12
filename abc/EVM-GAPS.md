# 50 primitivas de Ethereum/EVM vs. el ecosistema Stellar

**Método:** definí 50 referentes EVM por *función* (no por marca — ningún
proyecto Stellar se va a llamar "Uniswap") y busqué cada función sobre los 812
proyectos de `stellar-ecosystem-db`. Los resultados en cero los re-verifiqué
con términos alternativos, porque la primera pasada produce falsos negativos.

Conclusión de arranque, contra el estereotipo: **el ecosistema Stellar está
mucho más completo de lo que parece**. De 50 primitivas, solo una está
genuinamente ausente y debería existir.

---

## 1. Lo que está bien cubierto

| Función | Proyectos | Ejemplos |
|---|---|---|
| DEX / AMM | 100 | LumAgg, FX Swap |
| Analytics (Dune) | 67 | Steepx, Mobula, Genie AI |
| Lending (Aave) | 61 | Blend Capital, Lucent |
| Seguros | 60 | Ballast Re |
| RWA / Centrifuge | 52 | Neovestor, Dobprotocol |
| Oráculos (Chainlink) | 24 | Reflector, Band |
| Agregador DEX (1inch) | 23 | LumAgg, Basilic |
| Crédito a mercados emergentes | 22 | Microvault, Tribal, Paycashless |
| Privacidad | 17 | Sanctum, Stellot |
| Smart accounts / multisig (Safe) | 15 | Soropass, Teken |
| Explorer, indexación, tesorería | 10-13 | Sorscan, Obsrvr, Smart Treasury |
| Gobernanza / DAO | 46 | Tansu |

## 2. Lo que NO está — y no debería estar

Ausencias estructurales, no oportunidades. Stellar usa **SCP**, un modelo
federado bizantino: los validadores **no reciben recompensa por validar**, no
hay stake bloqueado ni slashing. Toda la familia de productos que en Ethereum
se construye encima del staking sencillamente no tiene sustrato acá.

| Primitiva | Hits | Por qué no aplica |
|---|---|---|
| Lido (liquid staking) | 4 falsos | No hay staking rewards en SCP |
| EigenLayer (restaking) | **0** | No hay stake que re-apostar |
| Ethena (dólar sintético basis) | **0** | Requiere mercados de perps profundos; Stellar tiene 7 proyectos de perps |
| Tornado (mixer) | **0** | Suicidio regulatorio en una cadena cuya tesis es cumplimiento y anchors |
| Blur (NFT pro trading) | **0** | Solo 4 marketplaces NFT y volumen marginal: no hay demanda que agregar |

Construir cualquiera de estas sería ingeniería sin usuario.

## 3. Lo que parecía no estar pero sí está

Falsos negativos de mi primera pasada. Los dejo documentados para que nadie
los "descubra" de nuevo:

| Creía vacío | Realidad |
|---|---|
| Gobernanza / voto (Snapshot) | 46 proyectos. **Tansu** es una plataforma de gobernanza on-chain completa |
| Crédito a mercados emergentes (Goldfinch) | 22 proyectos. **Microvault** (Kenia) hace microlending con vaults SEP-56 |
| Social (Farcaster / Lens) | 30 proyectos con ángulo social |
| Mensajería wallet-a-wallet (XMTP) | 10. **Paysapp** y **HandlPay** ya mandan activos por WhatsApp y usernames |
| Pagos en streaming (Sablier) | 4. **Drips**, **Zentra**, **Fundable** |

## 4. Lo delgado — oportunidad real pero con competencia naciente

| Función | Hits | Quiénes | Lectura |
|---|---|---|---|
| **Stableswap (Curve)** | **2** | Stabble, Sikadesk | El desajuste más llamativo del ecosistema — ver abajo |
| Renta fija / tokenización de yield (Pendle) | 4 | XCCY, Polaris Lend, YieldBack.Cash | Se está construyendo ahora mismo |
| Lending aislado / curado (Morpho) | 1 | Sentora | Blend es el pool monolítico; falta la capa curada |
| Membresías / token-gating (Unlock) | 1 | CommuniDAO | Cuotas de club, gimnasio, medio — muy aplicable a Latam |
| Intents / protección MEV (CowSwap) | 2 | Rozo, WOWMAX | Emergente |
| Gestión de posiciones (Instadapp) | 2 | XOXNO, BIM | |
| Paywall / monetización de creadores (Mirror) | 1 | QuillTip | |
| Pagos batch (Disperse) | 2 | Tracee, Airtm | |

### El desajuste del stableswap

Stellar tiene **69 proyectos de stablecoins** y **55 de on/off ramp**. Es,
por tesis y por composición, la cadena de las stablecoins. Y tiene **dos**
proyectos de liquidez entre stablecoins, ambos institucionales.

Nadie construyó el producto de consumidor para cambiar entre monedas locales
tokenizadas — ARST argentino, BRLT brasileño, las stablecoins africanas —
cuando el *path payment* es literalmente la operación nativa de Stellar desde
2015. La infraestructura existe y el producto no.

## 5. El único hueco que sobrevivió triple verificación

**Ahorro premiado / lotería sin pérdida (PoolTogether): 0 sobre 812.**

Lo busqué tres veces con términos distintos —`prize-linked`, `no-loss`,
`lottery`, `raffle`, `jackpot`, `sweepstake`, `prize savings`, `lossless`— y
los dos únicos resultados son gaming (Stellar Battle, Gladius), no ahorro.

Por qué importa más acá que en Ethereum:

- Stellar tiene **21 proyectos con tag *Unbanked*** y su tesis declarada es
  inclusión financiera. El ahorro premiado es, de toda la DeFi, el producto
  con mejor evidencia empírica para poblaciones no bancarizadas: convierte el
  gasto en lotería —conducta ya masiva en Latam— en ahorro.
- La infraestructura de rendimiento que necesita ya está: Blend, DeFindex,
  YieldBack.Cash. No hay que inventar el yield, hay que darle una razón.
- Coincide con el hallazgo del análisis anterior: el ecosistema tiene 33
  proyectos de *Yield* y cero productos de **conducta** de ahorro (redondeo,
  DCA, candados por meta, rondas rotativas, premios).

## Síntesis

La escasez en Stellar no está en las primitivas DeFi — están casi todas, y
varias bien construidas. Está en la **capa de producto de consumo**: lo que
hace que una persona sin educación financiera efectivamente use lo que ya
existe abajo.

Las primitivas las construyeron 812 equipos. Las razones para usarlas, nadie.
