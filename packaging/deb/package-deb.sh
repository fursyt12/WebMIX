#!/usr/bin/env bash
#
# Turn an Ubuntu build tree into the release .deb (and its debug symbols).
#
# The configure/build steps live in the workflow (they need the distribution's
# development packages); this script only drives CPack and renames what it
# produces into proper Debian file names:
#
#   webmix_<version>_amd64.deb
#   webmix-dbgsym_<version>_amd64.ddeb
#
#   ./package-deb.sh <build-dir> <output-dir>
#
# The package name comes from -DWEBMIX_PACKAGE_NAME=webmix, so these files can be
# installed next to the distribution's own obs-studio instead of replacing it.
set -euo pipefail

build="${1:?usage: package-deb.sh <build-dir> <output-dir>}"
out="${2:?usage: package-deb.sh <build-dir> <output-dir>}"
build="$(cd "${build}" && pwd)"
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"

version="$(sed -n 's/^set(CPACK_PACKAGE_VERSION "\(.*\)")$/\1/p' "${build}/CPackConfig.cmake" | head -1)"
if [[ -z "${version}" ]]; then
	echo "error: could not read CPACK_PACKAGE_VERSION from ${build}/CPackConfig.cmake" >&2
	exit 1
fi

arch="$(dpkg --print-architecture)"

echo "Packaging ${version} for ${arch}..."
(cd "${build}" && cmake --build . --target package)

shopt -s nullglob
debs=("${build}"/*.deb)
ddebs=("${build}"/*.ddeb)
shopt -u nullglob

if [[ ${#debs[@]} -eq 0 ]]; then
	echo "error: CPack produced no .deb in ${build}" >&2
	exit 1
fi

for file in "${debs[@]}"; do
	case "${file}" in
	*-dbgsym*) cp -v "${file}" "${out}/webmix-dbgsym_${version}_${arch}.ddeb" ;;
	*) cp -v "${file}" "${out}/webmix_${version}_${arch}.deb" ;;
	esac
done

# Older CPack emits the debug information as a separate .ddeb, newer ones keep it
# next to the package; accept both.
for file in "${ddebs[@]}"; do
	[[ -f "${out}/webmix-dbgsym_${version}_${arch}.ddeb" ]] && break
	cp -v "${file}" "${out}/webmix-dbgsym_${version}_${arch}.ddeb"
done

echo
echo "Packages in ${out}:"
ls -1 "${out}"/webmix*.deb "${out}"/webmix*.ddeb 2>/dev/null || true
