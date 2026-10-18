// rustc's proc-macro host imports (see rustc_proc_macro::bridge::remote, from
// toolchain/rustc-patches), forwarded to the object the embedder passes as
// `rustcProcMacroHost`. `run` is async: rustc suspends on it (JSPI) while the macro runs.
addToLibrary({
  __rustc_proc_macro_host_load__sig: 'iiii',
  __rustc_proc_macro_host_load: (path, len, firstSlot) =>
    Module['rustcProcMacroHost']?.load(path, len, firstSlot) ?? -1,
  __rustc_proc_macro_host_run__sig: 'iiiii',
  __rustc_proc_macro_host_run__async: true,
  __rustc_proc_macro_host_run: (slot, input, len, forceShowPanics) =>
    Module['rustcProcMacroHost'].run(slot, input, len, forceShowPanics),
});
