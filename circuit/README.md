# ExitProof policy circuit

11 inputs, 4 outputs (`allow`, 3-bit `reason`). Bit table and policy: see the design spec;
`spec.py` is the single source of truth.

- `spec.py` reference model (`policy`, `encode`, `decode`, `packed`)
- `policy.v` combinational RTL; `synth.ys` Yosys script (`abc -g NAND`)
- `build.py` synthesizes, converts to TapeOut bytes (7 bytes/gate `[00][a:u24][b:u24]`, wire 0/1 = const, inputs from wire 2,
  outputs = last 4 gates), verifies all 2048 inputs, writes `netlist.json` and `truth.json`
  (`truth.json[x] = allow | reason << 1`)
- `test_circuit.py` tests: `python3 -m unittest circuit/test_circuit.py` (from repo root)

Rebuild: `cd circuit && python3 build.py` (needs yosys).
