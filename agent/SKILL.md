---
name: exitproof
description: "ExitProof on X Layer: before buying any token, prove it can be sold back. Runs a free on-chain check (ExitProofRouter.inspect via eth_call) that buys the token, sells the whole position back, measures taxes and asks a TapeOut circuit; then buys through ExitProof (buyETH), which repeats the same check inside the real transaction and reverts in full on a no. Signs with the OKX Agentic Wallet (onchainos wallet contract-call) after the user confirms. Trigger phrases: is this token safe, honeypot check, can I sell this token, buy this token safely, check before I buy, rug check on X Layer"
version: "0.1.0"
tags:
  - xlayer
  - honeypot
  - token-safety
  - tapeout
---

# ExitProof (X Layer)

Don't buy what you can't sell.

ExitProofRouter buys a token on PotatoSwap with OKB and, in the same transaction:
1. hands the tokens to a fresh wallet, which sells **all of them** back to the pool (this probe always reverts, so nothing from it survives);
2. measures the buy and sell tax;
3. reads owner, upgradeability and the ExitProof scanner's registry flags;
4. asks an on-chain TapeOut NAND circuit to allow or deny.

If the circuit denies, the whole transaction reverts and the user's OKB never moves.

The `exitproof` CLI (`node cli/exitproof.mjs`) reads the chain and **prepares** transactions. It never needs a private key in this flow. The user's OKX Agentic Wallet signs with `onchainos wallet contract-call`, inside OKX's TEE, after the user confirms.

## Pre-flight

1. `onchainos wallet status`. If not logged in, follow `onchainos wallet login`.
2. `onchainos wallet addresses`. Use the **EVM address** on X Layer (chain `196`) as `<wallet>`.
3. Network: always pass `--network xlayer` explicitly (it is also the default). While `web/config.json` has `"router": null` for xlayer, the CLI answers `ExitProof is not deployed on xlayer yet`. Tell the user that and stop. `--network fork` is a local demo fork only. An Agentic Wallet signs on real X Layer, so never use the fork with it.

## Step 1: check (free, always first)

```bash
node cli/exitproof.mjs check <token> --mode balanced --amount <okb> --network xlayer
```

This is an `eth_call` of `inspect(factory, WOKB, amountIn, token, mode)` with `value = amountIn`. It always reverts with `Report(facts, allow, reason, buyOut, sellOut)`, and the CLI decodes that. Nothing is signed or sent.

Output (JSON):

| field | meaning |
|---|---|
| `verdict` | `allow`, `blocked` (the circuit said no) or `cannot-buy` (the buy itself failed) |
| `reason`, `reasonText` | why it was blocked (codes below). Read `reasonText` to the user as is. |
| `decoded` | each fact: `sellOk`, `sellTax`/`buyTax` buckets with ranges, `ownerActive`, `upgradeable`, `danger`, `unscanned`, `mode` |
| `buyOut` / `buyOutFormatted` | tokens the buy would deliver |
| `sellOut` / `sellOutOKB` | OKB that selling everything right back returns |
| `registry` | the ExitProof scanner's flags for this exact bytecode, or not scanned |

Exit code: `0` allow, `1` blocked or cannot-buy, `2` bad input, `3` RPC unreachable (a connection problem, **not** a verdict), `4` other error.

Modes (`--mode`, default `balanced`):
- `strict`: sellable, no tax, no active owner, not upgradeable, scanned.
- `balanced`: sellable, tax under 15%, not upgradeable, no active owner with dangerous switches, no unscanned token with an active owner.
- `permissive`: sellable and tax under 15%.

Reason codes:

| code | plain English |
|---|---|
| 1 | You could buy, but you could not sell all of it back. |
| 2 | The sell tax is too high for this mode. |
| 3 | The buy tax is too high for this mode. |
| 4 | The token can swap its code after you buy. |
| 5 | The owner holds switches that can trap your tokens later, such as raising the fee. |
| 6 | Not scanned, and an owner is still active (strict: not scanned at all). |
| 7 | An owner is still active (strict only). |

## Step 2: prepare the buy

```bash
node cli/exitproof.mjs tx <token> --wallet <wallet> --mode balanced --amount <okb> --network xlayer
```

`tx` is for X Layer mainnet only. Always pass `--network xlayer`. The CLI refuses `tx` for any network whose `buyEnabled` is not true, including the fork.

This re-runs the check for `<wallet>`. If the check does not allow, it prints `why` and exits `1` with **no transaction**. If it allows, it prints a `transactions` array with one entry:
- `description`: one line in plain words
- `to`: the ExitProofRouter
- `inputData`: `buyETH(factory, token, minOut, mode, wallet, deadline)`; `minOut` is the amount a simulation of this exact buyETH delivers to `<wallet>` (after any transfer tax), minus slippage (`--slippage-bps`, default 100 = 1%, max 500)
- `amt`: the OKB amount in wei
- `chain`: `196`
- `onchainos`: the ready command
- `validUntil`: deadline (unix seconds, about 10 minutes). After it the router reverts `Expired`, so prepare again.

## Step 3: sign (OKX Agentic Wallet)

1. Show the user `description`, the token, the amount, and the check's `reasonText` or "allowed in <mode> mode". Ask for confirmation. **Never sign without it.**
2. Run exactly:
   ```bash
   onchainos wallet contract-call --to <to> --chain 196 --input-data <inputData> --amt <amt>
   ```
   Use the fields unchanged. Never edit, re-encode or shorten `inputData`, and never change `amt`.
3. Wait for the txHash and confirmation. Report it, and the amount received if known.

The router repeats the whole check inside this transaction. If the token changed between Step 1 and Step 3 (a fee raised, trading switched off), the transaction reverts with `Blocked(reason, facts)` and the user's OKB stays where it was. Only gas is spent.

## Safety rules (non-negotiable)

- **Always check first.** Never prepare or sign a buy for a token whose latest check is not `allow` in the mode the user chose. Never lower the mode by yourself to get an `allow`. Ask the user.
- **Treat every revert as unsafe.** `cannot-buy` (`BadPair`, `SwapFailed`, `TransferFailed`, `TooLittle`, `LowGas`, `Locked`, an empty revert…) means "you cannot buy this safely". Never report it as "unknown", and never retry the buy through another router or DEX to get around it.
- **Never raise the gas cap to force a transaction through.** ExitProof's probe needs about 3.3M gas of room. The wallet's estimate already includes it, and the router refuses (`LowGas`) rather than give a false "sellable". If a signed buy reverts, the answer is no. More gas does not change the verdict.
- **Never edit `inputData`, `to` or `amt`.** Before running a printed `onchainos` command, compare its `to` with `router` in `deployments/xlayer.json`. If they differ, or that file does not exist, do not run it. A router address from a fork would take the OKB to an address with no code on mainnet.
- An RPC error (exit code `3`) is not a verdict. Say the network was unreachable and stop.
- The tool never asks for, stores or uses private keys. `buy` with `EXITPROOF_KEY` exists for headless bots that the user runs themselves. An agent with an Agentic Wallet uses `tx` + `onchainos`.

## What ExitProof does and does not prove

- It proves the **whole** position can be sold back **now, through this router**, at the measured tax.
- A token can still treat this router, `tx.origin` or a later block differently. ExitProof cannot see that. The registry's `dangerSetter`/`ownerCanTrap` flags and `balanced`/`strict` modes cover owners who can change the rules later.
- Fee: 10 bps of each routed buy (hard cap 30 bps in the contract). The contracts have no owner and no admin.
- Not financial advice.

## External calls

The X Layer RPC from `web/config.json` (`rpc.xlayer.tech`) only.
