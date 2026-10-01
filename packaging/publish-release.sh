#!/usr/bin/env bash
#
# Publish a built release to GitHub.
#
#   ./publish-release.sh <version> <dist-dir>
#
# Run by the release workflow, but usable by hand from a checkout with the
# artifacts of a local build (needs the `gh` CLI, authenticated):
#
#   packaging/publish-release.sh 0.1.0 dist
#
# The release notes come from packaging/RELEASE_NOTES.md.in with @VERSION@ and
# @TAG@ substituted. A single SHA256SUMS covering every asset is added so users
# only have to check one file.
set -euo pipefail

version="${1:?usage: publish-release.sh <version> <dist-dir>}"
dist="${2:?usage: publish-release.sh <version> <dist-dir>}"
tag="v${version}"
repo="${GITHUB_REPOSITORY:-fursyt12/WebMIX}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "${dist}"
dist="$(cd "${dist}" && pwd)"
if [[ -z "$(ls -A "${dist}")" ]]; then
	echo "error: ${dist} is empty" >&2
	exit 1
fi

if ! command -v gh >/dev/null; then
	echo "error: the gh CLI is required" >&2
	exit 1
fi

notes="$(mktemp)"
sed -e "s/@VERSION@/${version}/g" -e "s/@TAG@/${tag}/g" "${here}/RELEASE_NOTES.md.in" >"${notes}"
cp "${notes}" "${dist}/RELEASE_NOTES.md"

# The checksum file is generated last, so it covers exactly the release assets.
(
	cd "${dist}"
	rm -f SHA256SUMS
	find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\n' | sort | xargs -r sha256sum >SHA256SUMS
)

echo "Assets for ${tag}:"
ls -1 "${dist}"

if gh release view "${tag}" --repo "${repo}" >/dev/null 2>&1; then
	echo "Updating the existing release ${tag}..."
	gh release upload "${tag}" --repo "${repo}" --clobber "${dist}"/*
else
	echo "Creating the release ${tag}..."
	gh release create "${tag}" --repo "${repo}" \
		--title "WebMIX ${version}" \
		--notes-file "${notes}" \
		"${dist}"/*
fi

echo
echo "Release: https://github.com/${repo}/releases/tag/${tag}"
