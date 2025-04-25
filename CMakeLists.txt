cmake_minimum_required(VERSION 3.28)

project(HelloWorld)

set(WARNING_OPTIONS
    $<$<CXX_COMPILER_ID:MSVC>:/W4
    /WX>
    $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wall
    -Wextra
    -pedantic>
)

add_executable(hello_world source.cpp)
target_compile_options(hello_world PRIVATE ${WARNING_OPTIONS})
