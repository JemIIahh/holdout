# Net payouts per merchant
Read a CSV from stdin with the header `id,merchant,type,amount`.
`type` is `charge` or `refund`; `amount` is a positive decimal with exactly two decimals (e.g. 12.30).
Write one line per merchant to stdout, `merchant,net_cents`, sorted by merchant name
(ascending, byte order), with no header.
Rules:
1. net_cents = total charges minus total refunds, in integer cents. Do not use floating point.
2. If an id appears more than once, count only its first row.
3. Print every merchant that has at least one counted row, even if its net is 0 or negative.
4. If the input has only the header, print nothing.
Merchant names contain no commas or quotes.
Performance: the program must finish in under 0.5 ms, measured from process start to exit.
