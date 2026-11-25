#!/usr/bin/env python3
"""Synthesize policy.v with yosys to a NAND netlist, convert to TapeOut bytes, verify, write artifacts.

Netlist format: 7 bytes/gate [0x00][a:u24 BE][b:u24 BE]; wire 0 = const 0, wire 1 = const 1,
wires 2..12 = inputs (bit i of x), each gate appends one wire; outputs = last nOut gates.
"""
import hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import spec

N_IN, N_OUT = spec.N_IN, spec.N_OUT


def eval_gates(gates, x, n_in=N_IN, n_out=N_OUT):
    s = [0, 1] + [(x >> i) & 1 for i in range(n_in)]
    for a, b in gates:
        s.append(1 - (s[a] & s[b]))
    out = 0
    for i, v in enumerate(s[-n_out:]):
        out |= v << i
    return out


def parse_netlist(hexstr):
    h = hexstr[2:] if hexstr.startswith("0x") else hexstr
    raw = bytes.fromhex(h)
    assert len(raw) % 7 == 0, "netlist length not a multiple of 7"
    gates = []
    for i in range(0, len(raw), 7):
        assert raw[i] == 0, "non-NAND element"
        gates.append((int.from_bytes(raw[i + 1:i + 4], "big"), int.from_bytes(raw[i + 4:i + 7], "big")))
    return gates


def eval_netlist(hexstr, x):
    gates = parse_netlist(hexstr)
    for i, (a, b) in enumerate(gates):
        assert a < 2 + N_IN + i and b < 2 + N_IN + i, "wire out of range"
    return eval_gates(gates, x)


def run_yosys():
    subprocess.run(["yosys", "-q", "synth.ys"], cwd=HERE, check=True)
    with open(os.path.join(HERE, "policy_netlist.json")) as f:
        mod = json.load(f)["modules"]["policy"]
    ports = {n: p["bits"] for n, p in mod["ports"].items()}
    nand = []  # (a, b, y) in yosys bit ids / "0"/"1"
    for c in mod["cells"].values():
        c_in = c["connections"]
        if c["type"] == "$_NAND_":
            nand.append((c_in["A"][0], c_in["B"][0], c_in["Y"][0]))
        elif c["type"] == "$_NOT_":
            nand.append((c_in["A"][0], c_in["A"][0], c_in["Y"][0]))
        else:
            raise RuntimeError("unexpected cell " + c["type"])
    return ports["x"], ports["y"], nand


def to_gates(xbits, ybits, cells):
    wire = {"0": 0, "1": 1}
    for i, b in enumerate(xbits):
        wire[b] = 2 + i
    drv = {y: (a, b) for a, b, y in cells}
    order, seen = [], set()

    def visit(sig):
        if sig in wire or sig in seen:
            return
        seen.add(sig)
        a, b = drv[sig]
        visit(a), visit(b)
        order.append(sig)

    for y in ybits:
        visit(y)
    gates = []
    for sig in order:
        a, b = drv[sig]
        wire[sig] = 2 + N_IN + len(gates)
        gates.append((wire[a], wire[b]))
    return gates, ybits, wire


def finalize(gates, ybits, wire):
    """Build final gate list: body gates, then outputs; drop dead gates; re-index."""
    # Represent each gate as tuple of old-wire refs; outputs as separate specs.
    n_body = len(gates)
    body = list(gates)
    outs = []  # (a, b) refs in old-wire space; buffers need helper gates inserted into body
    for y in ybits:
        w = wire[y]
        idx = w - (2 + N_IN)
        if 0 <= idx < n_body:
            outs.append(body[idx])
        else:
            body.append((w, w))
            n = 2 + N_IN + len(body) - 1
            outs.append((n, n))
    # liveness
    live = [False] * len(body)
    stack = [r for g in outs for r in g]
    while stack:
        r = stack.pop()
        i = r - (2 + N_IN)
        if i >= 0 and not live[i]:
            live[i] = True
            stack.extend(body[i])
    remap = {0: 0, 1: 1}
    for i in range(N_IN):
        remap[2 + i] = 2 + i
    final = []
    for i, g in enumerate(body):
        if live[i]:
            remap[2 + N_IN + i] = 2 + N_IN + len(final)
            final.append((remap[g[0]], remap[g[1]]))
    for g in outs:
        final.append((remap[g[0]], remap[g[1]]))
    return final


def encode_hex(gates):
    return "0x" + b"".join(b"\x00" + a.to_bytes(3, "big") + b.to_bytes(3, "big") for a, b in gates).hex()


def verify(gates):
    for x in range(1 << N_IN):
        assert eval_gates(gates, x) == spec.packed(x), f"mismatch at x={x:#x}"


def main():
    xb, yb, cells = run_yosys()
    gates, ybits, wire = to_gates(xb, yb, cells)
    final = finalize(gates, ybits, wire)
    verify(final)
    hx = encode_hex(final)
    out = {"nIn": N_IN, "nOut": N_OUT, "gates": len(final), "netlist": hx,
           "sha256": hashlib.sha256(bytes.fromhex(hx[2:])).hexdigest()}
    with open(os.path.join(HERE, "netlist.json"), "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    with open(os.path.join(HERE, "truth.json"), "w") as f:
        json.dump([spec.packed(x) for x in range(1 << N_IN)], f)
        f.write("\n")
    print(f"gates={len(final)} sha256={out['sha256']}")


if __name__ == "__main__":
    main()
