# Proposal: Science Studio tabular import and column typing (GraphPad-like stats prep)

**Status:** awaiting maintainer scope approval — **do not implement or merge integration until approved**  
**Product surface:** Science Studio stats service + editor Chart workflow (sibling local app; REA holds investigation specs under `specs/science-studio/`)  
**Related REA spec:** `specs/science-studio/05-stats-module.md` (Phase 2 clean-room stats; not Prism reverse engineering)  
**Draft PR purpose:** record the analyst question, proposed contract, non-goals, and open decisions so maintainers can approve or narrow scope before substantial implementation.

---

## Decision needed

Should Science Studio gain a **local tabular import** path that accepts **Excel (`.xlsx` / `.xls`), CSV, and delimited TXT**, then returns a **typed column profile** (string / categorical / continuous / …) as the foundation for GraphPad-like test and plot selection?

This draft asks for an explicit **yes / narrow / decline** before any production wiring beyond this proposal.

---

## Problem and desired outcome

Today the stats service only accepts CSV and reports `numeric_columns` via pandas dtypes. That is insufficient for a Prism-like analysis assistant:

1. Biologists commonly deliver **Excel workbooks** and **tab- or whitespace-delimited TXT** exports.
2. GraphPad-style workflows need **semantic column roles**, not only “is numeric”:
   - continuous outcomes
   - categorical factors / groups
   - identifiers / free-text labels
   - (optional later) ordinal, datetime, boolean
3. Downstream test pickers (t-test, ANOVA, nonparametric) and plot grammars should consume a **stable typing contract**, with caller overrides when inference is wrong.

**Observable outcome (when approved and implemented):**

- User uploads a file in the Science Studio Chart / Stats UI.
- Service returns row count, sheet list (Excel), per-column inferred type + confidence + sample values, and lets the user confirm or override types.
- Confirmed profile is stored with the analysis id and used to enable only applicable tests/plots.

---

## Proposed analyst contract (sketch only)

### Upload

`POST /analyze/table` (multipart)

| Input                  | Notes                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| `file`                 | `.csv`, `.tsv`, `.txt`, `.xlsx`, `.xls`                                      |
| `sheet` (optional)     | Excel sheet name or 0-based index; default first sheet                       |
| `delimiter` (optional) | For TXT/CSV when auto-detect is ambiguous (`\t`, `,`, `;`, `\|`, whitespace) |
| `header` (optional)    | `true` / `false` / `auto`                                                    |

### Response (proposed)

```json
{
  "analysis_id": "uuid",
  "source": {
    "filename": "assay.xlsx",
    "format": "xlsx",
    "sheet": "Sheet1",
    "delimiter": null,
    "header": true
  },
  "row_count": 120,
  "columns": [
    {
      "name": "Group",
      "index": 0,
      "inferred_type": "categorical",
      "confidence": 0.94,
      "null_count": 0,
      "unique_count": 3,
      "sample_values": ["Control", "Drug A", "Drug B"],
      "levels": ["Control", "Drug A", "Drug B"],
      "reasons": ["low_cardinality", "non_numeric_strings"]
    },
    {
      "name": "Response",
      "index": 1,
      "inferred_type": "continuous",
      "confidence": 0.91,
      "null_count": 2,
      "unique_count": 110,
      "sample_values": [12.4, 15.1, 9.8],
      "reasons": ["mostly_finite_floats"]
    }
  ]
}
```

### Type vocabulary (v1)

| Type          | Meaning                                                            |
| ------------- | ------------------------------------------------------------------ |
| `continuous`  | Numeric measurements suitable for means / parametric or rank tests |
| `categorical` | Low-cardinality labels / factors / groups                          |
| `string`      | High-cardinality or free-text identifiers / notes                  |
| `boolean`     | Two-level logical columns (optional v1 if cheap)                   |
| `datetime`    | Parseable dates/times (optional v1; may defer)                     |
| `unknown`     | Insufficient signal; require user choice                           |

### Override

`POST /analyze/{analysis_id}/column-types`

```json
{ "columns": { "Group": "categorical", "Response": "continuous" } }
```

Preserves caller choices; never silently rewrites confirmed types.

---

## Inference rules (proposed; subject to approval)

Heuristic, documented, and overridable — not ML:

1. Empty / all-null → `unknown`.
2. ≥95% parseable as boolean tokens → `boolean` (if enabled).
3. ≥95% parseable as datetime → `datetime` (if enabled).
4. ≥95% finite numeric → `continuous` (integers with very low cardinality may be flagged as ambiguous continuous vs categorical).
5. Else if unique count ≤ `min(24, 0.05 * n_rows)` (tunable) → `categorical`.
6. Else → `string`.
7. Return `reasons[]` and `confidence` so the UI can show why.

**Ambiguity:** integer codes like `1,2,3` for treatment arms should surface as `continuous` **or** `categorical` with lower confidence and UI prompt — never auto-commit a test.

---

## Scope fit and non-goals

### In scope (Science Studio product; clean-room)

- Local file upload parsing (pandas / openpyxl).
- Column typing profile + user override.
- Wiring typed columns into existing t-test / ANOVA / plot endpoints **after** approval.
- Documentation and regression fixtures with synthetic public CSVs only.

### Explicit non-goals (this proposal)

- Reverse-engineering GraphPad Prism binaries, UI scripts, or proprietary file formats (`.pzfx` / Prism project internals).
- Copying Prism statistical implementations, defaults, or wording.
- Network fetch of remote datasets without an explicit later decision.
- Automatic choice of “the” correct statistical test without user confirmation.
- Shipping Excel engines that execute macros (macros must be ignored / refused).

Prism may later inform **workflow labels only** via local REA investigation (`05-stats-module.md`); that remains a separate obligation and does not authorize copying.

### Contribution / authority notes for REA maintainers

- This capability lives primarily in the **Science Studio** sibling app and its FastAPI stats service.
- REA impact is limited to **investigation specs / proposal docs** unless maintainers later ask for REA MCP tools around tabular evidence.
- Effects if implemented in Science Studio: **read caller-provided files**, local parse, optional write of analysis cache in memory/disk under the stats service — no process injection, no target mutation of third-party apps.

---

## Open questions requiring maintainer decision

1. **Approve v1 type set?** Include `boolean` / `datetime` now or defer?
2. **Excel engine:** `openpyxl` only (`.xlsx`) vs also `xlrd` / calamine for legacy `.xls`?
3. **Size limits:** max rows / columns / upload bytes for local-first safety?
4. **TXT detection:** accept only UTF-8 or also Latin-1 / BOM sniffing?
5. **Should typed profiles become part of Science Studio `FigureDocument` / ChartEmbed provenance**, or stay stats-service-only until a later schema proposal?
6. **REA packaging:** keep entirely outside REA, or eventually expose a read-only “inspect table” helper for evidence bundles?

Until these are answered, **no substantial implementation for integration**.

---

## Verification plan (after approval)

- Unit tests: delimiter detection, Excel sheet selection, each inferred type with golden fixtures (synthetic data only).
- Override tests: confirmed types never overwritten by re-inference.
- Malformed / empty / macro-bearing xlsx refused with tagged errors.
- Playwright (Science Studio): upload sample CSV → see typed columns → override → run enabled t-test.
- Document remaining unknowns (encoding edge cases, huge sheets).

---

## Implementation gate

| Stage                                            | Allowed now?                                |
| ------------------------------------------------ | ------------------------------------------- |
| This proposal + draft PR / design issue          | Yes                                         |
| Spike / throwaway prototype on a private branch  | Yes, if labeled non-integrating             |
| Merge to Science Studio default branch / ship UI | **No — needs explicit maintainer approval** |
| Expand into Prism format import or REA MCP tools | **No — new scope decision**                 |

---

## Suggested approval statement (for maintainers)

> Approved for Science Studio stats v1: local CSV/TSV/TXT/XLSX upload, column typing vocabulary {continuous, categorical, string, unknown[, boolean, datetime]}, caller overrides, size limit ___, Excel via ___. Prism RE and proprietary format import remain out of scope.
