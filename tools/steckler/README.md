# Steckler digitiser

The CFAST Validation Guide does not print the Steckler results as numbers. Appendix C.17 (printed pages 335 to 339,
PDF pages 359 to 363) has one plot per test. This script reads the vector drawing of nine of those plots and writes the
values to `validation/harness/published/steckler.ts`. The values are digitised, not printed in the Guide, and the
generated file says so.

Run it by hand. The app and `npm test` never call it.

## Needs

- Node 24 (runs the `.ts` file directly by type stripping; no `tsx`).
- poppler's `pdftocairo` on the PATH (macOS: `brew install poppler`; Debian/Ubuntu: `apt install poppler-utils`).
  Without it the script prints a message and stops.
- `docs/refs/CFAST_Validation_Guide.pdf`.

## Run

```
node tools/steckler/digitise.ts                      # default PDF, writes validation/harness/published/steckler.ts
node tools/steckler/digitise.ts other.pdf --out /tmp/steckler.ts
```

## What it does

1. Renders each needed PDF page to SVG with `pdftocairo -svg` into a temporary directory (removed afterwards).
2. Scans the SVG as data (paths, glyph references; nothing is evaluated), splits the page into plots and takes the
   test number from each plot title.
3. Fits each axis to its tick marks and printed labels. Glyphs are matched by a hash of their outline against a small
   table of digits (`GLYPH_HASHES` in the script).
4. Reads the 19 measured marker centres and the dashed CFAST line, and converts them to °C and m.
5. Writes, per test, the CFAST upper-layer temperature, the highest measured temperature, the CFAST layer height and
   the height of the highest measured point, rounded to 0.1 °C and 0.01 m.

## Self-checks

The script stops without writing when any plot fails one of these, and names the test:

- the plot is not found exactly once, or has no title with a test number;
- fewer than 19 or more than 19 measured points;
- fewer than 3 labelled ticks on an axis;
- an axis fit residual of 0.5 % of the span or more;
- not exactly one dashed CFAST line.

Output has no dates or machine paths, so running it again on the same PDF with the same poppler gives a byte-identical
file.

## Limits

- The glyph table covers the digits 0 to 8 and the decimal point. A plot whose tick labels or title use a digit 9
  (or another font) is not read, and the script stops.
- Reading uncertainty is about 0.1 °C and 0.01 m. The Guide does not state the time or averaging period of the
  profiles.
- The Guide is a NIST publication. The PDF stays in `docs/refs/`; only the numbers are written out, with page numbers.
