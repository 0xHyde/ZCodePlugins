cmake_minimum_required(VERSION 3.20)
project(zcode_campp_adapter LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(BUILD_CAMPP_ADAPTER "Build the ONNX Runtime JSONL adapter" ON)
option(BUILD_SPEAKER_CLUSTERING_TESTS "Build deterministic pure clustering tests" OFF)

add_library(speaker-clustering STATIC
  speaker-clustering.cpp
)
target_include_directories(speaker-clustering PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

if(BUILD_SPEAKER_CLUSTERING_TESTS)
  enable_testing()
  add_executable(speaker-clustering-test
    speaker-clustering-test.cpp
  )
  target_link_libraries(speaker-clustering-test PRIVATE speaker-clustering)
  add_test(NAME speaker-clustering-test COMMAND speaker-clustering-test)
endif()

if(NOT BUILD_CAMPP_ADAPTER)
  return()
endif()

if(NOT DEFINED SPEAKERLAB_ROOT)
  message(FATAL_ERROR "SPEAKERLAB_ROOT must point to 3D-Speaker/runtime/onnxruntime")
endif()
if(NOT DEFINED ONNXRUNTIME_ROOT)
  message(FATAL_ERROR "ONNXRUNTIME_ROOT must point to an extracted ONNX Runtime package")
endif()

set(SPEAKERLAB_SOURCE_ROOT "${SPEAKERLAB_ROOT}")
set(ONNXRUNTIME_INCLUDE "${ONNXRUNTIME_ROOT}/include")
set(ONNXRUNTIME_LIBRARY "${ONNXRUNTIME_ROOT}/lib")
set(NLOHMANN_INCLUDE "${SPEAKERLAB_ROOT}/third_party/nlohmann_json-src/include")

add_executable(campp-adapter
  campp-adapter.cpp
  "${SPEAKERLAB_SOURCE_ROOT}/utils/wav_reader.cpp"
  "${SPEAKERLAB_SOURCE_ROOT}/feature/feature_basic.cpp"
  "${SPEAKERLAB_SOURCE_ROOT}/feature/feature_common.cpp"
  "${SPEAKERLAB_SOURCE_ROOT}/feature/feature_functions.cpp"
  "${SPEAKERLAB_SOURCE_ROOT}/feature/feature_fbank.cpp"
)

target_include_directories(campp-adapter PRIVATE
  "${SPEAKERLAB_SOURCE_ROOT}"
  "${ONNXRUNTIME_INCLUDE}"
  "${NLOHMANN_INCLUDE}"
)
target_link_libraries(campp-adapter PRIVATE speaker-clustering)
target_link_directories(campp-adapter PRIVATE "${ONNXRUNTIME_LIBRARY}")
target_link_libraries(campp-adapter PRIVATE onnxruntime)

if(MSVC)
  # 3D-Speaker's feature code uses M_PI from <math.h>; MSVC only exposes it
  # when this compatibility macro is defined before the headers are parsed.
  target_compile_definitions(campp-adapter PRIVATE _USE_MATH_DEFINES NOMINMAX)
endif()

if(APPLE)
  set_target_properties(campp-adapter PROPERTIES
    BUILD_RPATH "@loader_path"
    INSTALL_RPATH "@loader_path"
    BUILD_WITH_INSTALL_RPATH TRUE
  )
elseif(UNIX)
  set_target_properties(campp-adapter PROPERTIES
    BUILD_RPATH "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
  )
endif()
