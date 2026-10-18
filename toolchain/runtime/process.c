// Processes for programs in the playground. Emscripten has no processes, so posix_spawn
// hands the child to the host (see process-host.js), which runs it elsewhere; the
// program is suspended meanwhile (JSPI). These override Emscripten's weak stubs, which
// fail with ENOSYS.
#include <errno.h>
#include <spawn.h>
#include <sys/types.h>

// musl's representation of file actions (src/process/fdop.h).
#define FDOP_CLOSE 1
#define FDOP_DUP2 2
#define FDOP_CHDIR 4
struct fdop {
  struct fdop *next, *prev;
  int cmd, fd, srcfd, oflag;
  mode_t mode;
  char path[];
};

// Starts `path` with the given stdio (file descriptors here, or -1 for closed) in `cwd`
// (or this one, if null). Returns its pid, or -errno.
int __rp_spawn(const char *path, char *const argv[], char *const envp[], int in, int out, int err,
               const char *cwd);
// Waits for a child; returns its pid (0 if it has not exited and WNOHANG), or -errno.
int __rp_wait(pid_t pid, int *status, int options);

static int spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa,
                 char *const argv[], char *const envp[]) {
  int fds[3] = {0, 1, 2};
  const char *cwd = 0;
  struct fdop *op = fa ? fa->__actions : 0;
  // The newest action is first.
  while (op && op->next) op = op->next;
  for (; op; op = op->prev) {
    switch (op->cmd) {
    case FDOP_DUP2:
      if (op->fd < 3) fds[op->fd] = op->srcfd < 3 ? fds[op->srcfd] : op->srcfd;
      break;
    case FDOP_CLOSE:
      if (op->fd < 3) fds[op->fd] = -1;
      break;
    case FDOP_CHDIR:
      cwd = op->path;
      break;
    default:
      return ENOTSUP;
    }
  }
  int r = __rp_spawn(path, argv, envp, fds[0], fds[1], fds[2], cwd);
  if (r < 0) return -r;
  if (pid) *pid = r;
  return 0;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  return spawn(pid, path, fa, argv, envp);
}

// The host looks programs up itself.
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  return spawn(pid, file, fa, argv, envp);
}

int __syscall_wait4(int pid, int *status, int options, int rusage) {
  return __rp_wait(pid, status, options);
}
