// Files whose bytes are elsewhere: the embedder gives such a file's node a `remote`
// object, with `read(position, length)` returning a promise of the bytes. Reading the
// file suspends rustc (JSPI) while they are fetched; the node's stream_ops.read then
// copies them in from `remote.pending`, as a read of any other file would. rustc reads
// crate metadata this way a page at a time (see toolchain/rustc-patches), so the
// sysroot's metadata can live in another Worker.
addToLibrary({
  fd_read__deps: ['$doReadv'],
  fd_read__async: true,
  fd_read: (fd, iov, iovcnt, pnum) => {
    var stream, remote;
    var done = () => {
      var num = doReadv(stream, iov, iovcnt);
      {{{ makeSetValue('pnum', 0, 'num', SIZE_TYPE) }}};
      return 0;
    };
    var fail = (e) => {
      if (!(e instanceof FS.ErrnoError)) throw e;
      return e.errno;
    };
    try {
      stream = SYSCALLS.getStreamFromFD(fd);
      remote = stream.node.remote;
      if (!remote) return done();
      var length = 0;
      for (var i = 0; i < iovcnt; i++) {
        length += {{{ makeGetValue('iov', "i * " + C_STRUCTS.iovec.__size__ + " + " + C_STRUCTS.iovec.iov_len, '*') }}};
      }
      var position = stream.position;
      length = Math.max(0, Math.min(length, stream.node.usedBytes - position));
    } catch (e) {
      return fail(e);
    }
    return remote.read(position, length).then(
      (bytes) => {
        remote.pending = { position, bytes };
        try {
          return done();
        } catch (e) {
          return fail(e);
        } finally {
          remote.pending = null;
        }
      },
      () => {{{ cDefs.EIO }}},
    );
  },
});
