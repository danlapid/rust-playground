// The entry points of a proc-macro module: a proc-macro crate compiled for
// wasm32-unknown-emscripten, linked with this shim into a program that runs on its own,
// in a Dynamic Worker, while rustc runs elsewhere.
//
// rustc's side of the proc_macro bridge is reached through one import, `dispatch`. The
// bridge already speaks in byte buffers (handles are integers), so each request and
// reply is copied between this module and rustc by the host, as is the macro's input
// and output. The host makes `dispatch` a JSPI-suspending import and `pm_run` a
// promising export, so a request can wait for rustc's reply.
#![feature(proc_macro_internals)]
#![allow(internal_features)]

extern crate proc_macro;

use std::ffi::c_void;
use std::mem;

use proc_macro::bridge::client::Client;

// The macro's clients, from the proc-macro crate (rustc gives the static this name on
// Emscripten targets).
unsafe extern "Rust" {
    #[link_name = "__rustc_proc_macro_decls"]
    static DECLS: &'static [Client];
}

#[link(wasm_import_module = "proc_macro_host")]
unsafe extern "C" {
    /// Sends a bridge request to rustc. The host writes the reply with `pm_alloc` and
    /// returns its length.
    fn dispatch(request: *const u8, len: usize) -> usize;
}

// The bridge's types, which are `#[repr(C)]` because they cross this boundary in rustc
// too (between rustc and a proc-macro dylib).
#[repr(C)]
struct Buffer {
    data: *mut u8,
    len: usize,
    capacity: usize,
    reserve: extern "C" fn(Buffer, usize) -> Buffer,
    drop: extern "C" fn(Buffer),
}

#[repr(C)]
struct Closure {
    call: extern "C" fn(*mut c_void, Buffer) -> Buffer,
    env: *mut c_void,
}

#[repr(C)]
struct BridgeConfig {
    input: Buffer,
    dispatch: Closure,
    force_show_panics: bool,
}

impl Buffer {
    fn from_vec(v: Vec<u8>) -> Buffer {
        let mut v = mem::ManuallyDrop::new(v);
        Buffer { data: v.as_mut_ptr(), len: v.len(), capacity: v.capacity(), reserve, drop: drop_buffer }
    }

    fn into_vec(self) -> Vec<u8> {
        let b = mem::ManuallyDrop::new(self);
        unsafe { Vec::from_raw_parts(b.data, b.len, b.capacity) }
    }

    /// Copies out the contents of a buffer from the client, and frees it its way.
    fn take(self) -> Vec<u8> {
        let bytes = unsafe { std::slice::from_raw_parts(self.data, self.len) }.to_vec();
        (self.drop)(self);
        bytes
    }
}

extern "C" fn reserve(b: Buffer, additional: usize) -> Buffer {
    let mut v = b.into_vec();
    v.reserve(additional);
    Buffer::from_vec(v)
}

extern "C" fn drop_buffer(b: Buffer) {
    drop(b.into_vec());
}

/// Where the host writes into this module: the macro's input, and replies from rustc.
static mut INBOX: Vec<u8> = Vec::new();
/// The macro's output, for the host to read after `pm_run`.
static mut OUTBOX: Vec<u8> = Vec::new();

#[unsafe(no_mangle)]
pub extern "C" fn pm_alloc(len: usize) -> *mut u8 {
    unsafe {
        INBOX = vec![0; len];
        (*&raw mut INBOX).as_mut_ptr()
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pm_count() -> usize {
    unsafe { DECLS.len() }
}

#[unsafe(no_mangle)]
pub extern "C" fn pm_output() -> *const u8 {
    unsafe { (*&raw const OUTBOX).as_ptr() }
}

extern "C" fn call_dispatch(_env: *mut c_void, request: Buffer) -> Buffer {
    let request = request.take();
    unsafe {
        let len = dispatch(request.as_ptr(), request.len());
        let reply = mem::take(&mut *&raw mut INBOX);
        debug_assert_eq!(reply.len(), len);
        Buffer::from_vec(reply)
    }
}

/// Runs macro `index` on the input in the inbox; returns the length of the output.
#[unsafe(no_mangle)]
pub extern "C" fn pm_run(index: usize, force_show_panics: bool) -> usize {
    unsafe {
        let client = DECLS[index];
        // `Client` is `#[repr(C)]` around the client's entry point.
        let run: extern "C" fn(BridgeConfig) -> Buffer = mem::transmute(client);
        let input = Buffer::from_vec(mem::take(&mut *&raw mut INBOX));
        let config = BridgeConfig {
            input,
            dispatch: Closure { call: call_dispatch, env: std::ptr::null_mut() },
            force_show_panics,
        };
        OUTBOX = run(config).take();
        (*&raw const OUTBOX).len()
    }
}

fn main() {}
