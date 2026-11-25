import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spec, build

HERE = os.path.dirname(os.path.abspath(__file__))


def load_netlist():
    import json
    with open(os.path.join(HERE, "netlist.json")) as f:
        return json.load(f)


class TestCircuit(unittest.TestCase):
    def test_examples(self):
        for mode in (1, 2):
            self.assertEqual(spec.policy(spec.encode(sellOk=1, mode=mode)), (1, 0))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, mode=0)), (1, 0))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, unscanned=1, mode=0)), (0, 6))
        self.assertEqual(spec.policy(spec.encode({"sellOk": 1, "ownerActive": 1, "mode": 0})), (0, 7))
        self.assertEqual(spec.policy(spec.encode(sellOk=0, mode=2)), (0, 1))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, sellTax=2, mode=1)), (0, 2))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, buyTax=2, mode=1)), (0, 3))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, sellTax=1, buyTax=1, mode=2)), (1, 0))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, sellTax=1, mode=0)), (0, 2))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, ownerActive=1, danger=1, mode=1)), (0, 5))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, ownerActive=1, unscanned=1, mode=1)), (0, 6))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, unscanned=1, mode=1)), (1, 0))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, upgradeable=1, mode=1)), (0, 4))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, upgradeable=1, mode=2)), (1, 0))

    def test_reason_priority(self):
        self.assertEqual(spec.policy(spec.encode(sellOk=0, upgradeable=1, mode=0)), (0, 1))
        self.assertEqual(spec.policy(spec.encode(sellOk=0, upgradeable=1, mode=1)), (0, 1))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, sellTax=3, buyTax=3, upgradeable=1, mode=1)), (0, 2))
        self.assertEqual(spec.policy(spec.encode(sellOk=1, buyTax=3, upgradeable=1, mode=1)), (0, 3))

    def test_mode3_equals_strict(self):
        for x in range(1 << 9):
            self.assertEqual(spec.policy(x | (3 << 9)), spec.policy(x))

    def test_reason_zero_iff_allow(self):
        for x in range(2048):
            a, r = spec.policy(x)
            self.assertEqual(a == 1, r == 0)

    def test_netlist_format(self):
        nl = load_netlist()
        self.assertEqual((nl["nIn"], nl["nOut"]), (11, 4))
        raw = bytes.fromhex(nl["netlist"][2:])
        self.assertEqual(len(raw) % 7, 0)
        self.assertEqual(len(raw) // 7, nl["gates"])
        self.assertGreaterEqual(nl["gates"], 4)
        for i in range(nl["gates"]):
            g = raw[7 * i:7 * i + 7]
            self.assertEqual(g[0], 0)
            a, b = int.from_bytes(g[1:4], "big"), int.from_bytes(g[4:7], "big")
            self.assertLess(a, 2 + 11 + i)
            self.assertLess(b, 2 + 11 + i)

    def test_netlist_exhaustive(self):
        nl = load_netlist()
        for x in range(2048):
            a, r = spec.policy(x)
            self.assertEqual(build.eval_netlist(nl["netlist"], x), a | (r << 1), hex(x))

    def test_truth_json(self):
        import json
        t = json.load(open(os.path.join(HERE, "truth.json")))
        self.assertEqual(len(t), 2048)
        for x in range(2048):
            a, r = spec.policy(x)
            self.assertEqual(t[x], a | (r << 1))

    def test_sha256(self):
        import hashlib
        nl = load_netlist()
        self.assertEqual(hashlib.sha256(bytes.fromhex(nl["netlist"][2:])).hexdigest(), nl["sha256"])


if __name__ == "__main__":
    unittest.main()
