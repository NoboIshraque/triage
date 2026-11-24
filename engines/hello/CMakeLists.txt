# "Hello engine": the smallest Triage engine process. ROADMAP P0-4 grows it into
# the engine connection pattern (broker, MessagePort, restart handling).

add_library(triage_hello_core STATIC src/hello.cpp)
add_library(triage::hello_core ALIAS triage_hello_core)
target_include_directories(triage_hello_core PUBLIC include)
target_compile_definitions(triage_hello_core PRIVATE TRIAGE_VERSION="${PROJECT_VERSION}")
target_link_libraries(triage_hello_core PRIVATE triage::warnings)

add_executable(triage-hello-engine src/main.cpp)
target_link_libraries(triage-hello-engine PRIVATE triage::hello_core triage::warnings)

add_executable(triage_hello_test tests/hello_test.cpp)
target_link_libraries(triage_hello_test PRIVATE triage::hello_core triage::warnings)

add_test(NAME hello.unit COMMAND triage_hello_test)
# Windows writes "\r\n" for "\n" on text-mode stdout, so the CR is optional.
string(REPLACE "." "[.]" _hello_version_re "${PROJECT_VERSION}")
add_test(NAME hello.version COMMAND triage-hello-engine --version)
set_tests_properties(hello.version PROPERTIES
  PASS_REGULAR_EXPRESSION "^triage-hello-engine ${_hello_version_re}\r?\n$")
add_test(NAME hello.bad_argument COMMAND triage-hello-engine --frobnicate)
set_tests_properties(hello.bad_argument PROPERTIES WILL_FAIL TRUE)
