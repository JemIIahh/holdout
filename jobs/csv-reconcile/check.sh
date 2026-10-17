#!/bin/bash
# check.sh: runs /work/solution.py on the three visible examples; exit 0 only on 3/3.
W="${WORK:-/work}"; T="${TMPDIR:-/tmp}"; pass=0
for n in 1 2 3; do
  got=$(python3 "$W/solution.py" < "$W/examples/$n.in" 2> "$T/check_err_$n"); rc=$?
  want=$(cat "$W/examples/$n.out")
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then
    echo "PASS example $n"; pass=$((pass+1))
  else
    echo "FAIL example $n (exit $rc)"
    diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | head -n 12
    head -c 400 "$T/check_err_$n"
  fi
done
echo "$pass/3 examples passed"; [ "$pass" -eq 3 ]
