# Triage's EDA engine (ROADMAP P1-2, P1-3), built inside KiCad's own CMake tree:
# patch 0001 adds this directory when KICAD_TRIAGE_DIR points here
# (engines/eda/build.mjs sets it). Everything here is Triage's code (GUIDELINES §6).
#
#   triage_eda_api       the triage.eda.v1 protobuf messages, a shared library like
#                        KiCad's kiapi (protobuf registers a message once per process)
#   pcbnew/eeschema      the board and schematic engine faces, the Stream GAL and
#   kifaces              their helpers, compiled into KiCad's kifaces (KICAD_TRIAGE)
#   triage-eda-engine    the engine host: kicad-cli's program setup, the faces behind
#                        a KIWAY, and the P0-4 engine connection to the broker

set( TRIAGE_EDA_ENGINE_VERSION "0.1.0" )
set( TRIAGE_HELLO_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../hello )

# --- triage_eda_api -----------------------------------------------------------------

set( TRIAGE_PROTO_DIR ${CMAKE_CURRENT_SOURCE_DIR}/api/proto )
set( TRIAGE_PROTO_OUT ${CMAKE_CURRENT_BINARY_DIR}/cpp )
set( TRIAGE_PROTO_SRCS triage/eda/v1/engine.proto )
set( TRIAGE_PROTO_CPP
    ${TRIAGE_PROTO_OUT}/triage/eda/v1/engine.pb.cc
    ${TRIAGE_PROTO_OUT}/triage/eda/v1/engine.pb.h )

add_custom_command(
    OUTPUT ${TRIAGE_PROTO_CPP}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${TRIAGE_PROTO_OUT}
    COMMAND ${Protobuf_PROTOC_EXECUTABLE}
        --cpp_out=dllexport_decl=TRIAGE_API_EXPORT:${TRIAGE_PROTO_OUT}
        --proto_path=${TRIAGE_PROTO_DIR}
        ${TRIAGE_PROTO_SRCS}
    WORKING_DIRECTORY ${TRIAGE_PROTO_DIR}
    DEPENDS ${TRIAGE_PROTO_DIR}/triage/eda/v1/engine.proto
    COMMENT "Generating Triage's EDA engine API (triage.eda.v1)" )

add_library( triage_eda_api SHARED ${TRIAGE_PROTO_CPP} )
set_target_properties( triage_eda_api PROPERTIES LINKER_LANGUAGE CXX )
target_include_directories( triage_eda_api SYSTEM PUBLIC ${TRIAGE_PROTO_OUT} ${Protobuf_INCLUDE_DIRS} )
target_link_libraries( triage_eda_api PUBLIC protobuf::libprotobuf )

if( MSVC )
    target_compile_definitions( triage_eda_api
        PRIVATE TRIAGE_API_EXPORT=__declspec\(dllexport\)
        INTERFACE TRIAGE_API_EXPORT=__declspec\(dllimport\) )
else()
    # KiCad hides symbols by default (CMAKE_CXX_VISIBILITY_PRESET hidden); the engine
    # and both kifaces link this library, so it exports everything.
    target_compile_definitions( triage_eda_api PUBLIC TRIAGE_API_EXPORT= )
    set_target_properties( triage_eda_api PROPERTIES
        CXX_VISIBILITY_PRESET default
        VISIBILITY_INLINES_HIDDEN OFF )
endif()

if( KICAD_USE_CMAKE_FINDPROTOBUF AND Protobuf_VERSION AND Protobuf_VERSION VERSION_GREATER_EQUAL 4.0 )
    target_link_libraries( triage_eda_api PUBLIC absl::hash absl::log_internal_check_op )
endif()

install( TARGETS triage_eda_api
    RUNTIME DESTINATION ${KICAD_BIN}
    LIBRARY DESTINATION ${KICAD_LIB}
    COMPONENT binary )

# --- The engine faces, inside KiCad's kifaces ----------------------------------------

set( TRIAGE_FACE_COMMON_SRCS
    ${CMAKE_CURRENT_SOURCE_DIR}/common/face_util.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/stream_gal/stream_gal.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/stream_gal/display_list.cpp )

target_sources( pcbnew_kiface PRIVATE
    ${TRIAGE_FACE_COMMON_SRCS}
    ${CMAKE_CURRENT_SOURCE_DIR}/pcb/pcb_face.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/pcb/pcb_edit.cpp )
target_compile_definitions( pcbnew_kiface PRIVATE KICAD_TRIAGE )
target_include_directories( pcbnew_kiface PRIVATE
    ${CMAKE_SOURCE_DIR}/pcbnew/python/scripting )
target_link_libraries( pcbnew_kiface PRIVATE triage_eda_api )

target_sources( eeschema_kiface PRIVATE
    ${TRIAGE_FACE_COMMON_SRCS}
    ${CMAKE_CURRENT_SOURCE_DIR}/sch/sch_face.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/sch/sch_edit.cpp )
target_compile_definitions( eeschema_kiface PRIVATE KICAD_TRIAGE )
target_link_libraries( eeschema_kiface PRIVATE triage_eda_api )

# --- triage-eda-engine ------------------------------------------------------------------

include_directories( BEFORE ${INC_BEFORE} )
include_directories( ${CMAKE_SOURCE_DIR}/common ${INC_AFTER} )

add_executable( triage-eda-engine
    engine/main.cpp
    engine/host.cpp
    ${TRIAGE_HELLO_DIR}/src/hello.cpp
    ${TRIAGE_HELLO_DIR}/src/protocol.cpp
    ${TRIAGE_HELLO_DIR}/src/transport.cpp )

target_include_directories( triage-eda-engine PRIVATE ${TRIAGE_HELLO_DIR}/include )
target_compile_definitions( triage-eda-engine PRIVATE
    TRIAGE_EDA_ENGINE_VERSION="${TRIAGE_EDA_ENGINE_VERSION}"
    TRIAGE_VERSION="${TRIAGE_EDA_ENGINE_VERSION}" )

if( MSVC )
    # A console program: wmain, and its output in the terminal.
    set_target_properties( triage-eda-engine PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE" )
    target_compile_definitions( triage-eda-engine PRIVATE _CONSOLE )
endif()

target_link_libraries( triage-eda-engine
    nlohmann_json
    common
    gal
    common      # repeated: gal and common depend on each other (as for kicad-cli)
    pads_common
    kicommon
    core
    ${wxWidgets_LIBRARIES}
    triage_eda_api )

# The engine loads the kifaces it extends.
add_dependencies( triage-eda-engine pcbnew_kiface eeschema_kiface )

install( TARGETS triage-eda-engine
    DESTINATION ${KICAD_BIN}
    COMPONENT binary )
