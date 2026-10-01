#!/usr/bin/env bash
#
# Build the Arch package and the pacman repository database.
#
# Run this as a normal user: makepkg refuses to run as root. In CI it runs in an
# archlinux container as a freshly created build user (see
# .github/workflows/release.yml).
#
#   ./build-package.sh [output-dir]
#
# Produces, in the output directory:
#   webmix-<version>-<rel>-x86_64.pkg.tar.zst
#   webmix.db, webmix.db.tar.gz, webmix.files, webmix.files.tar.gz
#
# The four database files are plain copies of each other: pacman is happy with
# either name, and a GitHub release cannot carry the symlinks repo-add creates.
set -euo pipefail

out="${1:-.}"
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -eq 0 ]]; then
	echo "error: makepkg must not run as root; create a build user first" >&2
	exit 1
fi

cd "${here}"

# A cached VCS mirror from an earlier run may point at a different URL, or lack
# the tag this PKGBUILD asks for, and makepkg would quietly reuse it. Start from
# a clean source every time; --cleanbuild only clears what is already unpacked.
rm -rf "${here}/src" "${here}/pkg" "${here}/webmix"

makepkg --noconfirm --cleanbuild --force --syncdeps

pkg=(webmix-*.pkg.tar.zst)
cp -v "${pkg[@]}" "${out}/"

cd "${out}"
repo-add --quiet --new webmix.db.tar.gz "${pkg[@]}"

# repo-add leaves webmix.db / webmix.files as symlinks to the .tar.gz files.
# A GitHub release cannot carry symlinks, so replace them with real copies -
# pacman accepts either name.
rm -f webmix.db webmix.files
cp webmix.db.tar.gz webmix.db
cp webmix.files.tar.gz webmix.files

echo
echo "Repository ready in ${out}:"
ls -1 webmix*.pkg.tar.zst webmix.db webmix.files
