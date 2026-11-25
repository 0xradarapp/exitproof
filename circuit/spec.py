"""Reference model for the ExitProof policy circuit (single source of truth).

Input bits (LSB first): 0 sellOk, 1-2 sellTax, 3-4 buyTax, 5 ownerActive,
6 upgradeable, 7 danger, 8 unscanned, 9-10 mode (0 strict, 1 balanced, 2 permissive, 3 strict).
Output: (allow, reason); packed as allow | reason << 1.
"""
N_IN = 11
N_OUT = 4

FIELDS = {  # name: (shift, width)
    "sellOk": (0, 1), "sellTax": (1, 2), "buyTax": (3, 2), "ownerActive": (5, 1),
    "upgradeable": (6, 1), "danger": (7, 1), "unscanned": (8, 1), "mode": (9, 2),
}


def encode(facts=None, **kw):
    f = dict(facts or {})
    f.update(kw)
    unknown = set(f) - set(FIELDS)
    if unknown:
        raise KeyError(sorted(unknown))
    x = 0
    for name, v in f.items():
        shift, width = FIELDS[name]
        if not 0 <= v < (1 << width):
            raise ValueError(f"{name}={v} out of range")
        x |= v << shift
    return x


def decode(x):
    return {n: (x >> s) & ((1 << w) - 1) for n, (s, w) in FIELDS.items()}


def policy(x):
    f = decode(x)
    mode = f["mode"]
    if mode == 3:
        mode = 0
    sell_ok, st, bt = f["sellOk"], f["sellTax"], f["buyTax"]
    owner, upg, dng, uns = f["ownerActive"], f["upgradeable"], f["danger"], f["unscanned"]
    max_tax = 0 if mode == 0 else 1
    if not sell_ok:
        return (0, 1)
    if st > max_tax:
        return (0, 2)
    if bt > max_tax:
        return (0, 3)
    if mode == 2:
        return (1, 0)
    if upg:
        return (0, 4)
    if mode == 1:
        if owner and dng:
            return (0, 5)
        if owner and uns:
            return (0, 6)
        return (1, 0)
    if dng:
        return (0, 5)
    if uns:
        return (0, 6)
    if owner:
        return (0, 7)
    return (1, 0)


def packed(x):
    a, r = policy(x)
    return a | (r << 1)
