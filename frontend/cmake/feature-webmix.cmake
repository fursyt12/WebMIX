# WebMIX: browser frontend served from inside OBS.
#
# Adds the built-in HTTP server that delivers the web/ directory and exposes
# the control endpoints the websocket protocol does not cover (shutdown, and
# the obs-websocket connection details).  Used by `obs --web`, where the Qt
# window is never shown and the web interface is the only UI.

target_sources(
  obs-studio
  PRIVATE
    webmix/OBSBasic_WebMix.cpp
    webmix/WebMixBridge.cpp
    webmix/WebMixBridge.hpp
    webmix/WebMixOperations.cpp
    webmix/WebMixPreview.cpp
    webmix/WebMixPreview.hpp
    webmix/WebMixServer.cpp
    webmix/WebMixServer.hpp
)

# Let a build-tree run of OBS find the frontend without installation.
file(TO_CMAKE_PATH "${CMAKE_SOURCE_DIR}/web" WEBMIX_WEB_DIR)
target_compile_definitions(obs-studio PRIVATE "WEBMIX_SOURCE_WEB_DIR=\"${WEBMIX_WEB_DIR}\"")

# ...and ship it with `cmake --install`, so an installed OBS finds it in
# <datadir>/obs-studio/web (see WebMixServer::ResolveWebRoot).
if(NOT DEFINED CMAKE_INSTALL_DATAROOTDIR)
  include(GNUInstallDirs)
endif()

install(
  DIRECTORY "${CMAKE_SOURCE_DIR}/web/"
  DESTINATION "${CMAKE_INSTALL_DATAROOTDIR}/obs-studio/web"
  PATTERN "test" EXCLUDE
  PATTERN "tools" EXCLUDE
  PATTERN "node_modules" EXCLUDE
)
