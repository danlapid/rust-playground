// The JS side of process.c: children of a program, run by the embedder's
// Module.processHost, asynchronously (these are JSPI imports).
//
// processHost.has(program) says whether the host can run a program (by path, or name),
// and processHost.run({program, args, env, cwd, stdin}) runs one to completion, resolving
// to {status, stdout, stderr}.
addToLibrary({
  $rpChildren: { next: 1000, byPid: new Map() },

  // An empty pipe with every write end closed is at EOF: read returns 0. (Emscripten's
  // PIPEFS throws EAGAIN, so a parent reading a child's output to the end never would.)
  $rpPipeEof__deps: ['$PIPEFS'],
  $rpPipeEof__postset: 'rpPipeEof();',
  $rpPipeEof: () => {
    const { read } = PIPEFS.stream_ops;
    PIPEFS.stream_ops.read = (stream, ...args) => {
      const pipe = stream.node.pipe;
      if (pipe.writeClosed && !pipe.buckets.some((b) => b.offset > b.roffset)) return 0;
      return read(stream, ...args);
    };
  },

  // Runs a child, with what is in its stdin, and writes its output to its stdout and
  // stderr: whatever those are here (pipes to the parent, the parent's own, ...).
  $rpRun__deps: ['$FS'],
  $rpRun: async (child) => {
    const chunks = [];
    if (child.stdin) {
      const buf = new Uint8Array(65536);
      for (;;) {
        let n = 0;
        try {
          n = FS.read(child.stdin, buf, 0, buf.length);
        } catch (e) {
          // EAGAIN: an empty pipe that is still open. What was written is all there is.
          if (!(e instanceof FS.ErrnoError)) throw e;
        }
        if (n <= 0) break;
        chunks.push(buf.slice(0, n));
      }
    }
    const stdin = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((at, c) => (stdin.set(c, at), at + c.length), 0);
    const { status, stdout, stderr } = await Module['processHost'].run({
      program: child.program,
      args: child.args,
      env: child.env,
      cwd: child.cwd,
      stdin,
    });
    for (const [stream, data] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      if (stream && data?.length) FS.write(stream, data, 0, data.length);
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) if (stream) FS.close(stream);
    child.status = status;
  },

  __rp_spawn__async: true,
  __rp_spawn__sig: 'ipppiiip',
  __rp_spawn__deps: ['$rpChildren', '$rpRun', '$rpPipeEof', '$FS', '$UTF8ToString'],
  __rp_spawn: async (path, argv, envp, stdin, stdout, stderr, cwd) => {
    const host = Module['processHost'];
    const program = UTF8ToString(path);
    if (!host?.has(program)) return -{{{ cDefs.ENOENT }}};
    const strings = (ptr) => {
      const out = [];
      for (let p; (p = HEAPU32[ptr >> 2]); ptr += 4) out.push(UTF8ToString(p));
      return out;
    };
    const env = {};
    for (const kv of strings(envp)) {
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    // The child's own references to the streams, which the parent closes its copies of.
    const dup = (fd) => (fd < 0 ? null : FS.dupStream(FS.getStreamChecked(fd)));
    const child = {
      program,
      args: strings(argv).slice(1),
      env,
      cwd: cwd ? UTF8ToString(cwd) : FS.cwd(),
      stdin: dup(stdin),
      stdout: dup(stdout),
      stderr: dup(stderr),
    };
    const pid = rpChildren.next++;
    rpChildren.byPid.set(pid, child);
    // A child that reads a pipe from the parent runs once the parent waits for it, when
    // it has written what it will. Others run now, so the parent can read their output.
    if (!(child.stdin && FS.isFIFO(child.stdin.node.mode))) await (child.done = rpRun(child));
    return pid;
  },

  __rp_wait__async: true,
  __rp_wait__sig: 'iipi',
  __rp_wait__deps: ['$rpChildren', '$rpRun'],
  __rp_wait: async (pid, status, options) => {
    const { byPid } = rpChildren;
    if (pid <= 0) pid = byPid.keys().next().value ?? 0;
    const child = byPid.get(pid);
    if (!child) return -{{{ cDefs.ECHILD }}};
    if (!child.done && options & 1 /* WNOHANG */) return 0;
    await (child.done ??= rpRun(child));
    byPid.delete(pid);
    if (status) HEAP32[status >> 2] = (child.status & 0xff) << 8;
    return pid;
  },
});
