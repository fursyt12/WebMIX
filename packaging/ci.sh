#!/usr/bin/env bash
#
# Helpers for the release workflow (sourced, not executed).
#
# A failed configure or build line is only visible to someone with access to the
# repository's Actions logs. `ci_run` streams the output as usual and, when the
# command fails, re-emits its last lines as `::error::` annotations, which the
# run's API reports publicly - enough to see what went wrong from the outside.

ci_run() {
	local log
	log="$(mktemp)"
	local code=0

	set +e
	"$@" 2>&1 | tee "${log}"
	code=${PIPESTATUS[0]}
	set -e

	if ((code != 0)); then
		local line
		while IFS= read -r line; do
			printf '::error::%s\n' "${line}"
		done < <(tail -n 20 "${log}")
	fi

	rm -f "${log}"
	return "${code}"
}
