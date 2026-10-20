#!/usr/bin/env bash
# Open a parity issue in StackOneHQ/defender-py when stackone-defender is behind a TS release.
# Usage: TS_VERSION=0.9.4 scripts/python-parity-issue.sh   (DRY_RUN=1 prints instead of creating)
# Needs GH_TOKEN with Issues: write on defender-py (REPO_GH_PAT in CI). ENG-1249 part C.
set -euo pipefail

PY_REPO="StackOneHQ/defender-py"
TS_REPO="StackOneHQ/defender"
TS_VERSION="${TS_VERSION:?set TS_VERSION, e.g. 0.9.4}"
TS_VERSION="${TS_VERSION#v}"

if [[ ! "$TS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "invalid TS_VERSION '$TS_VERSION': expected X.Y.Z" >&2
	exit 2
fi

# Python's version from its latest GitHub release: release-please tags it in the job that publishes
# to PyPI, and the API isn't cached (PyPI's project JSON can lag behind an upload).
PY_TAG="$(gh release view --repo "$PY_REPO" --json tagName --jq '.tagName')"
PY_VERSION="${PY_TAG#stackone-defender-v}"
if [[ ! "$PY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "unexpected latest defender-py release tag '$PY_TAG'" >&2
	exit 1
fi
echo "npm @stackone/defender: $TS_VERSION, stackone-defender (latest release): $PY_VERSION"

# Python is in step when its version is the same or newer.
if [ "$(printf '%s\n%s\n' "$PY_VERSION" "$TS_VERSION" | sort -V | tail -n1)" = "$PY_VERSION" ]; then
	echo "Python is not behind; no issue needed."
	exit 0
fi

TITLE="[parity] @stackone/defender v$TS_VERSION"
existing="$(gh issue list --repo "$PY_REPO" --state open --search "\"$TITLE\" in:title" --json number,title \
	--jq "map(select(.title == \"$TITLE\")) | .[0].number // empty")"
if [ -n "$existing" ]; then
	echo "Already open: https://github.com/$PY_REPO/issues/$existing"
	exit 0
fi

BODY="$(cat <<BODY_EOF
@stackone/defender **v$TS_VERSION** is on npm. \`stackone-defender\` is at **v$PY_VERSION**.

- Release notes: https://github.com/$TS_REPO/releases/tag/defender-v$TS_VERSION
- Changes since the Python version: https://github.com/$TS_REPO/compare/defender-v$PY_VERSION...defender-v$TS_VERSION

To bring Python level:
1. Re-pin the fixtures: \`scripts/sync_conformance.sh defender-v$TS_VERSION\`. New cases fail until the port lands; list them in \`tests/conformance_known_failures.txt\` meanwhile.
2. Port the behavior changes, then remove those lines.
3. Release, so \`stackone-defender\` reaches v$TS_VERSION.

If the release changed nothing that applies to Python (docs, CI, packaging), say so here and close it. Python still bumps its version to stay in step.

Opened by \`scripts/python-parity-issue.sh\` in $TS_REPO (ENG-1249).
BODY_EOF
)"

if [ "${DRY_RUN:-}" = "1" ]; then
	printf 'DRY RUN: would open in %s\n--- %s\n%s\n' "$PY_REPO" "$TITLE" "$BODY"
	exit 0
fi
gh issue create --repo "$PY_REPO" --title "$TITLE" --body "$BODY"
