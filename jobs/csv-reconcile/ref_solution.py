import sys

seen = set()
net = {}
for line in sys.stdin.read().split("\n"):
    line = line.rstrip("\r")
    if not line or line == "id,merchant,type,amount":
        continue
    rid, merchant, kind, amount = line.split(",")
    if rid in seen:
        continue
    seen.add(rid)
    whole, frac = amount.split(".")
    cents = int(whole) * 100 + int(frac)
    net[merchant] = net.get(merchant, 0) + (cents if kind == "charge" else -cents)
for merchant in sorted(net):
    print(f"{merchant},{net[merchant]}")
