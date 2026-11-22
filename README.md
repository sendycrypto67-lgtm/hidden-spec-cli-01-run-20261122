# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sendycrypto67-lgtm/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sendycrypto67-lgtm/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend`: one patch tool for every AI edit format. It applies a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON to a tree of text files. Every file is changed or nothing is.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto` (default, detected from the patch text).
- `--check`: do everything but write, same output and exit code.
- `--strict`: match lines exactly (tier 0 only).
- PATCH is the patch file path, or `-`/absent for standard input.

Exit 0 lists the changed files (`A`/`D`/`M`/`R`) and `ok: <n> files`; exit 1 lists each failed edit and `failed: <k> of <n> edits`; exit 2 is a usage, no-patch, format, or parse error.

## How it works

- Line matching runs in three tiers: exact, then ignoring trailing spaces/tabs, then ignoring leading and trailing spaces/tabs, with tier 2 re-indenting replacement lines to the file's own indentation.
- Unified hunks pick the occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE requires exactly one occurrence; V4A chunks walk a cursor with anchors and end-of-file chunks.
- Edits apply in order to the tree as earlier edits left it, and the whole patch is all-or-nothing: any failed edit means no file is written.

## Layout

- `main.ts` — the whole CLI, Node 22 standard library only.
- `runner.ts` — the kit's trial runner, kept as shipped.
- `LICENSE` — MIT.

## Practice score

100/100 checks pass locally (unified 30, search-replace 20, v4a 20, json 15, cli 15).

---

<sub>Entered on [make.fun](https://make.fun/?ref=y8skhesk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
