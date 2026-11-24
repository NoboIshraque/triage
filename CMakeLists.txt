# Triage's own native code (C++). The forked engines (KiCad, FreeCAD, Espressif
# QEMU) keep their own CMake/Meson builds under engines/<name>/ and are not
# added here (GUIDELINES §6).
cmake_minimum_required(VERSION 3.25)

project(triage_native
  VERSION 0.0.0
  DESCRIPTION "Triage native engine processes"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(TRIAGE_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" OFF)
# Off by default: the Windows CI images carry an unrelated ccache (Strawberry Perl).
option(TRIAGE_USE_CCACHE "Use ccache (or sccache) when one is installed" OFF)

if(TRIAGE_USE_CCACHE)
  find_program(TRIAGE_COMPILER_LAUNCHER NAMES ccache sccache)
  if(TRIAGE_COMPILER_LAUNCHER)
    message(STATUS "Compiler launcher: ${TRIAGE_COMPILER_LAUNCHER}")
    set(CMAKE_CXX_COMPILER_LAUNCHER "${TRIAGE_COMPILER_LAUNCHER}")
    # ccache can't cache MSVC's separate PDB files; embed debug info instead.
    set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<$<CONFIG:Debug,RelWithDebInfo>:Embedded>")
  endif()
endif()

# Warning flags shared by every Triage native target.
add_library(triage_warnings INTERFACE)
add_library(triage::warnings ALIAS triage_warnings)
if(MSVC)
  target_compile_options(triage_warnings INTERFACE /W4 /permissive- /utf-8 /Zc:__cplusplus
    $<$<BOOL:${TRIAGE_WARNINGS_AS_ERRORS}>:/WX>)
else()
  target_compile_options(triage_warnings INTERFACE -Wall -Wextra -Wpedantic -Wconversion
    -Wshadow $<$<BOOL:${TRIAGE_WARNINGS_AS_ERRORS}>:-Werror>)
endif()

enable_testing()

add_subdirectory(engines/hello)
