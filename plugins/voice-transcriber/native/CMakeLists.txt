cmake_minimum_required(VERSION 3.20)
project(zcode_campp_adapter LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

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
target_link_directories(campp-adapter PRIVATE "${ONNXRUNTIME_LIBRARY}")
target_link_libraries(campp-adapter PRIVATE onnxruntime)

if(APPLE)
  set_target_properties(campp-adapter PROPERTIES
    BUILD_RPATH "@loader_path"
    INSTALL_RPATH "@loader_path"
  )
elseif(UNIX)
  set_target_properties(campp-adapter PROPERTIES
    BUILD_RPATH "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
  )
endif()
