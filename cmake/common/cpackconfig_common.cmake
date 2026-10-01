# OBS CMake common CPack module

include_guard(GLOBAL)

# Set default global CPack variables
#
# WebMIX: releases are packaged as `webmix` so they can be installed next to the
# distribution's own obs-studio instead of fighting it over the version number
# (a fork built as 0.1.0 would otherwise be "older" than obs-studio 32.x and get
# replaced by it on the next system upgrade). Builds that do not set
# WEBMIX_PACKAGE_NAME keep the upstream name.
if(NOT DEFINED WEBMIX_PACKAGE_NAME)
  set(WEBMIX_PACKAGE_NAME "obs-studio")
endif()

set(CPACK_PACKAGE_NAME "${WEBMIX_PACKAGE_NAME}")
set(CPACK_PACKAGE_CHECKSUM SHA256)

# The package metadata follows the package name: a `webmix` build is this fork
# and should say so, an obs-studio build stays upstream's.
if(WEBMIX_PACKAGE_NAME STREQUAL "obs-studio")
  set(CPACK_PACKAGE_VENDOR "${OBS_WEBSITE}")
  set(CPACK_PACKAGE_HOMEPAGE_URL "${OBS_WEBSITE}")
  set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "${OBS_COMMENTS}")
else()
  set(CPACK_PACKAGE_VENDOR "WebMIX")
  set(CPACK_PACKAGE_HOMEPAGE_URL "https://github.com/fursyt12/WebMIX")
  set(CPACK_PACKAGE_DESCRIPTION_SUMMARY
      "OBS Studio with the WebMIX browser interface: the whole UI is served over HTTP and rendered with WebGPU"
  )
endif()

set(CPACK_PACKAGE_VERSION_MAJOR ${OBS_VERSION_MAJOR})
set(CPACK_PACKAGE_VERSION_MINOR ${OBS_VERSION_MINOR})
set(CPACK_PACKAGE_VERSION_PATCH ${OBS_VERSION_PATCH})
