# WebMIX: browser frontend served from inside OBS.
#
# Adds the built-in HTTP server that delivers the web/ directory and exposes
# the control endpoints the websocket protocol does not cover (shutdown, and
# the obs-websocket connection details).  Used by web mode (the default launch),
# where the Qt window is never shown and the web interface is the only UI.

# The preview encoder prefers libjpeg over Qt's writer, for two reasons that both
# matter at 60 fps: Qt enables Huffman optimisation (about 3x the encode time
# for a few percent of size), and it picks the chroma subsampling for us. See
# WebMixPreview.cpp.
#
# It is optional on purpose. The Windows dependency bundle does not expose
# libjpeg through CMake's finder, and a codec the preview merely prefers must
# not fail a configure: when it is missing the same file compiles a Qt-based
# encoder instead.
find_package(JPEG)
if(JPEG_FOUND)
  target_compile_definitions(obs-studio PRIVATE WEBMIX_HAVE_LIBJPEG)
  target_link_libraries(obs-studio PRIVATE JPEG::JPEG)
else()
  message(STATUS "WebMIX: libjpeg not found; the preview will use Qt's JPEG writer")
endif()

target_sources(
  obs-studio
  PRIVATE
    webmix/OBSBasic_WebMix.cpp
    webmix/WebMixBridge.cpp
    webmix/WebMixFiles.cpp
    webmix/WebMixBridge.hpp
    webmix/WebMixControl.cpp
    webmix/WebMixControl.hpp
    webmix/WebMixControlInternal.hpp
    webmix/WebMixControlEvents.cpp
    webmix/WebMixControl_General.cpp
    webmix/WebMixControl_Scenes.cpp
    webmix/WebMixControl_Inputs.cpp
    webmix/WebMixControl_Outputs.cpp
    webmix/WebMixOperations.cpp
    webmix/WebMixPreview.cpp
    webmix/WebMixPreview.hpp
    webmix/WebMixRemux.cpp
    webmix/WebMixRemux.hpp
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

# Windows installs OBS's data under <root>/data (bin/64bit/obs.exe reaches it as
# ../../data), everywhere else under <prefix>/share. WebMixServer::ResolveWebRoot
# knows both.
if(WIN32)
  set(WEBMIX_WEB_INSTALL_DIR "${OBS_DATA_DESTINATION}/obs-studio/web")
else()
  set(WEBMIX_WEB_INSTALL_DIR "${CMAKE_INSTALL_DATAROOTDIR}/obs-studio/web")
endif()

install(
  DIRECTORY "${CMAKE_SOURCE_DIR}/web/"
  DESTINATION "${WEBMIX_WEB_INSTALL_DIR}"
  PATTERN "test" EXCLUDE
  PATTERN "tools" EXCLUDE
  PATTERN "node_modules" EXCLUDE
)

# Packages also install the same binary as `webmix`, so the web mode has an
# obvious entry point: `webmix` (web mode is the default). macOS ships an app
# bundle instead.
if(UNIX AND NOT APPLE)
  install(
    CODE
      "
    execute_process(COMMAND \"${CMAKE_COMMAND}\" -E create_symlink obs
      \"\$ENV{DESTDIR}${CMAKE_INSTALL_FULL_BINDIR}/webmix\")
  "
  )

  # The launcher that starts OBS straight into web mode.
  install(
    FILES "${CMAKE_CURRENT_SOURCE_DIR}/webmix/webmix.desktop"
    DESTINATION "${CMAKE_INSTALL_DATAROOTDIR}/applications"
  )
endif()
