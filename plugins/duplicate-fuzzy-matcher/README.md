# DataRefine Duplicate & Fuzzy Matcher

A local-first DataRefine Studio plugin for finding similar-but-not-identical values in one text column and replacing reviewed variants with a canonical spelling.

**Requires:** DataRefine Studio `>=1.0.0` and an open dataset.

## Workflow

1. Open a dataset.
2. Open **Duplicate Matcher** from the activity bar.
3. Enter a text column such as `customer_name`.
4. Choose a method and threshold.
5. Press **Preview possible match groups**.
6. Review the bounded report. If a group should not be changed, enter its group number in **Ignore group numbers** and preview again.
7. Choose the canonical-value strategy.
8. Press **Merge into canonical values**.

The merge is one normal DataRefine plugin operation, so it appears in workspace history and can be undone. It changes cell values; it does not delete rows or merge records across columns.

## Matching methods

- **Hybrid** — combines Levenshtein ratio, Jaro-Winkler, character bigram similarity, and a small Soundex boost.
- **Normalized** — case-folds Unicode text, removes punctuation differences, and collapses whitespace.
- **Levenshtein distance** — edit similarity after compact normalization.
- **Jaro-Winkler** — useful for short names and transpositions.
- **Character n-gram** — compares overlapping character bigrams.
- **Phonetic / Soundex** — English-oriented phonetic matching; non-Latin text remains safe but may not receive a phonetic match.

Exact normalized values are grouped regardless of the fuzzy threshold. For names, start around 88–92%; raise the threshold when false positives matter more than missed matches.

## Safety and privacy

- No permissions are requested.
- No network, filesystem, subprocess, AI, cloud, or credential APIs are used.
- The dataset stays in the local DataRefine runtime.
- Preview is read-only.
- Apply does not delete rows and is recorded as one undoable operation.
- A maximum distinct-value limit prevents an accidental expensive all-pairs comparison.
- The plugin may return the selected column as text when a merge changes it, which is appropriate for names and other text values.

## Uninstall

Open the DataRefine Extensions panel, select **Duplicate & Fuzzy Matcher**, and choose **Unload** or **Uninstall**. Unloading removes its sidebar view; it does not delete the active dataset or its history.

## Package contents

- `manifest.json` — Marketplace metadata and capabilities.
- `datarefine.plugin.json` — DataRefine UI and command contribution.
- `main.py` — local matching and canonicalization engine.
