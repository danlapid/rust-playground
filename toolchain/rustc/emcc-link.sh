#!/usr/bin/env bash
# Linker for the rustc host binary: em++ (LLVM needs the C++ runtime), plus the settings
# for running rustc as a factory module in a Worker or Node (MEMFS root, NODEFS to mount
# real files), and the proc-macro host imports and remote files, with JSPI so a proc
# macro can run, or a file's bytes be fetched, asynchronously elsewhere. The proc-macro
# dispatcher is not a JSPI export: a macro calls it thousands of times, and each
# promising call would get a stack.
#
# Memory starts small and grows 2 MiB at a time, so that it tracks what rustc uses: a
# Worker's memory limit counts all of it. It's imported, so that the embedder can reuse
# one memory for every run rather than leave the last run's for the garbage collector.
# The stack is 8 MiB, as rustc's main thread has natively.
# -Oz has binaryen shrink the module, which a Worker's size limit counts.
exec em++ "$@" -Oz \
  -sMODULARIZE=1 -sEXPORT_ES6 -sEXPORT_NAME=createRustc -sENVIRONMENT=node -sASSERTIONS=0 \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8388608 -sINITIAL_MEMORY=33554432 -sMEMORY_GROWTH_LINEAR_STEP=2097152 -sIMPORTED_MEMORY \
  -lnodefs.js -sFORCE_FILESYSTEM \
  -sEXPORTED_RUNTIME_METHODS=FS,NODEFS,MEMFS,ENV,callMain \
  --js-library "$(dirname "$0")/proc-macro-host.js" --js-library "$(dirname "$0")/remote-files.js" \
  -sJSPI -sJSPI_EXPORTS=main
