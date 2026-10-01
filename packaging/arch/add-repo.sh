#!/usr/bin/env bash
#
# Add (or remove) the WebMIX pacman repository and install the package.
#
#   ./add-repo.sh              # add the repository, then ask before installing
#   ./add-repo.sh --install    # add it and install webmix right away
#   ./add-repo.sh --remove     # remove the repository again
#   ./add-repo.sh --dry-run    # print what would be written, change nothing
#
# The repository lives on the project's GitHub releases: the packages and the
# repo database are release assets, so "latest" always points at the newest
# build. Nothing here is signed, hence SigLevel = Optional TrustAll - see
# packaging/README.md for what that means before you use it on a machine you
# care about.
set -euo pipefail

REPO_NAME="webmix"
REPO_URL="${WEBMIX_REPO_URL:-https://github.com/fursyt12/WebMIX/releases/latest/download}"
PACMAN_CONF="${PACMAN_CONF:-/etc/pacman.conf}"
MARKER_BEGIN="# >>> ${REPO_NAME} repository >>>"
MARKER_END="# <<< ${REPO_NAME} repository <<<"

mode="add"
case "${1:-}" in
	--install) mode="install" ;;
	--remove) mode="remove" ;;
	--dry-run) mode="dry-run" ;;
	--help | -h)
		sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	"") ;;
	*)
		echo "unknown option: $1 (try --help)" >&2
		exit 2
		;;
esac

if [[ ! -f "${PACMAN_CONF}" ]]; then
	echo "error: ${PACMAN_CONF} not found; is this an Arch system?" >&2
	exit 1
fi

# Everything below needs root: use sudo when the config is not ours to write.
sudo=""
if [[ ! -w "${PACMAN_CONF}" ]]; then
	sudo="sudo"
fi

as_root() {
	if [[ -n "${sudo}" ]]; then
		"${sudo}" "$@"
	else
		"$@"
	fi
}

section() {
	cat <<EOF

${MARKER_BEGIN}
[${REPO_NAME}]
SigLevel = Optional TrustAll
Server = ${REPO_URL}
${MARKER_END}
EOF
}

current="$(cat "${PACMAN_CONF}")"

case "${mode}" in
remove)
	if [[ "${current}" != *"${MARKER_BEGIN}"* ]]; then
		echo "The ${REPO_NAME} repository is not configured in ${PACMAN_CONF}."
		exit 0
	fi
	echo "Removing the ${REPO_NAME} repository from ${PACMAN_CONF}..."
	as_root python3 - "${PACMAN_CONF}" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r"\n*# >>> webmix repository >>>.*?# <<< webmix repository <<<\n?", "\n", text, flags=re.S)
open(path, "w").write(text)
PY
	as_root pacman -Sy
	echo "Done. The installed package was left alone; remove it with: sudo pacman -R webmix"
	;;
dry-run)
	if [[ "${current}" == *"${MARKER_BEGIN}"* ]]; then
		echo "Already configured in ${PACMAN_CONF}."
	else
		echo "Would append to ${PACMAN_CONF}:"
		section
	fi
	echo "Would then run: pacman -Sy"
	;;
*)
	if [[ "${current}" == *"${MARKER_BEGIN}"* ]]; then
		echo "The ${REPO_NAME} repository is already configured in ${PACMAN_CONF}."
	else
		echo "Adding the ${REPO_NAME} repository to ${PACMAN_CONF}..."
		printf '%s' "$(section)" | as_root tee -a "${PACMAN_CONF}" >/dev/null
	fi

	as_root pacman -Sy

	# The database is fetched once so a typo in the URL fails here, with a clear
	# message, instead of inside the install below.
	if ! pacman -Si "${REPO_NAME}" >/dev/null 2>&1; then
		echo "error: ${REPO_NAME} is not in the synced databases; check ${REPO_URL}" >&2
		exit 1
	fi
	echo
	pacman -Si "${REPO_NAME}" | sed -n '1,4p'

	if [[ "${mode}" == "install" ]]; then
		echo
		as_root pacman -S --needed "${REPO_NAME}"
	else
		echo
		echo "Install it with:  sudo pacman -S ${REPO_NAME}"
	fi
	;;
esac
