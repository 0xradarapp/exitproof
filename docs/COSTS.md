# ExitProof costs

Gas amounts and fork spend were **measured** on an anvil fork of X Layer mainnet at block 76,861,306 (2026-11-25),
using the same scripts that run on mainnet. Everything marked *(estimate)* is derived from those measurements: mainnet
OKB figures (measured gas × the mainnet gas price read that day), attestation and DeWEB storage costs, the budget, and
the USD values. Prices are as of 2026-11-25: **OKB ≈ $81**, **BEM ≈ $7.86**.

## Fork gas price vs mainnet gas price

The fork ran at about **1.02 gwei**, anvil's base fee. Mainnet `eth_gasPrice` returned **0.02 gwei** on 2026-11-25.
So the gas part of the OKB figures below is roughly 50× too high for mainnet. The protocol fees (TAPEOUT_FEE, BEM)
are the same on both.

## Tape-out (`scripts/tapeout.mjs`)

| Step | Gas | Fee |
|---|---:|---|
| approve 0.1 BEM to the TapeOut factory | 46,393 | – |
| createCPU "ExitProof Guard" | 958,595 | 0.1 BEM (`deployFee`) |
| approve 0.01 BEM to our transistors contract | 46,393 | – |
| mint 54 NAND | 171,399 | 0.01 BEM (`protocolFee`, one mint call); mint price 0 OKB |
| tapeout(netlist, 11, 4) | 388,880 | 0.0013 OKB (`TAPEOUT_FEE`) |
| **Total** | **1,611,660** | **0.11 BEM + 0.0013 OKB** |

- Measured on the fork: **0.002934 OKB + 0.11 BEM**, which is 0.0013 OKB of fee plus about 0.00163 OKB of gas at 1.02 gwei.
- At mainnet gas (0.02 gwei), the gas is about 0.000032 OKB, so the total is about **0.00133 OKB + 0.11 BEM ≈ $0.11 + $0.86 ≈ $0.97** *(estimate)*.

## Registry + router (`scripts/deploy.mjs`)

| Step | Gas |
|---|---:|
| deploy RiskRegistry | 461,780 |
| setAttester(deployer, true) | 47,781 |
| deploy ExitProofRouter | 2,088,103 |
| **Total** | **2,597,664** |

- Measured on the fork: **0.002617 OKB**.
- At mainnet gas: about **0.000052 OKB** (well under $0.01) *(estimate)*.

## Per buy (paid by the buyer)

| | Gas | At 0.02 gwei |
|---|---:|---:|
| First buy of a codehash (scan + ProbeHolder), real processor + PotatoSwap | ≈756k | ≈0.000015 OKB |
| Later buys (scan cached) | ≈503k | ≈0.00001 OKB |
| First buy of a ~24 KB token (worst-case fill), offline / with the real eval | 4.82M / ≈4.99M (estimate) | ≈0.0001 OKB |
| Worst blocked case (24 KB probe-cap token) | 7.62M | ≈0.00015 OKB |
| `inspect` (free check, `eth_call`) | – | 0 |

- **Router fee:** 10 bps of the buy amount (0.00001 OKB on a 0.01 OKB buy). The PotatoSwap pool fee of 25 bps comes on top.
- **Gas limit:** don't cap it. A typical buy needs at least **3.5M available** but uses only about 0.5–0.8M; the rest is headroom the probe needs. The first buy of a near-24 KB token can need about 5M, so the web app and CLI fall back to 8M. The large-token figures come from the stress suite (commit `2cd45cf`).

## Scanner attestations (operator, estimate)

`RiskRegistry.attest` writes one struct and a report URI per codehash, roughly 50–80k gas, which is about 0.0000015 OKB
at 0.02 gwei. Attesting every new PotatoSwap pair at about 100 pairs a day costs well under 0.001 OKB a day.

## DeWEB (`scripts/build-deweb.mjs` + `scripts/publish-deweb.mjs`; mainnet figures are estimates)

Fees, read from mainnet on 2026-11-25:

- **Opening the circuit's ERC-6551 container:** a one-time `FEE()` of **0.08 OKB (≈ $6.50)**, paid to the opener `0x536a…0106`.
- **`.tape` name:** `monthlyFee()` on DomainBinding is **0**, so a 12-month binding costs nothing beyond gas.

Gas, **measured** on a fork of block 76,869,339 (publish of `dist/deweb/`: 12 files, 673,977 bytes):

| Step | Gas |
|---|---:|
| open container | 167,256 |
| 35 upload txs (putFile/appendChunk, 24,000-byte chunks, ≈224 gas/byte; a full chunk is 5,366,591) | ≈153.57M |
| setFallback("index.html") | 114,238 |
| bind(name, container, 12) | 185,482 |
| **Total (38 txs)** | **154,038,564** |

- At 0.02 gwei this is about 0.00308 OKB of gas, so the publish costs about **0.0831 OKB (≈ $6.73)** and 0 BEM *(estimate)*.
- A re-publish of changed files pays only the upload gas for those files; the container fee is paid once.

## Mainnet budget recommendation (estimate)

| Item | OKB | BEM |
|---|---:|---:|
| Tape-out fee + gas | 0.0015 | 0.11 |
| Registry + router | 0.0001 | – |
| Demo buys (a few × 0.01 OKB) + gas | 0.03 | – |
| Attestations for the demo and the daemon's first days | 0.001 | – |
| DeWEB: container fee + upload gas (optional) | 0.0831 | – |
| Headroom (gas spikes, a retry) | 0.02 | 0.01 |
| **Total without DeWEB** | **≈0.05** | **0.12** |
| **Total with DeWEB** | **≈0.14** | **0.12** |

On 2026-11-25 the deployer `0x2ef6…c92c` held 0.01802 OKB and 0 BEM.

- **Before the tape-out:** top up to **at least 0.05 OKB**, and buy **at least 0.12 BEM**: swap about 0.015 OKB on the BEM/WOKB pool, or bridge BEM from BSC through tapeout.net. `tapeout.mjs` checks both balances before sending anything.
- **Before DeWEB:** add about 0.09 OKB (0.0831 plus headroom).

In US dollars, everything except the demo buys and DeWEB comes to **about $1**. With DeWEB, the total is **about $12**.
