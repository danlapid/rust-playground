// wasm-ld only: the stock lld driver also pulls in the ELF, COFF and MachO linkers.
#include "lld/Common/Driver.h"
#include "llvm/Support/raw_ostream.h"

LLD_HAS_DRIVER(wasm)

int main(int argc, const char **argv) {
  lld::Result r = lld::lldMain(llvm::ArrayRef(argv, argc), llvm::outs(), llvm::errs(),
                               {{lld::Wasm, &lld::wasm::link}});
  return r.retCode;
}
