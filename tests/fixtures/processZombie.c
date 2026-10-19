#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Keep an owned child live for the first snapshot, then hold its exit until
 * the observer finishes. Closing stdin releases both stages on test failure. */
int main(void) {
  int gate[2];
  if (pipe(gate) == -1) return 1;
  pid_t child = fork();
  if (child == -1) return 2;
  if (child == 0) {
    close(gate[1]);
    char byte;
    read(gate[0], &byte, 1);
    close(gate[0]);
    _exit(0);
  }

  close(gate[0]);
  printf("%d\n", child);
  fflush(stdout);
  getchar();
  close(gate[1]);
  siginfo_t info;
  if (waitid(P_PID, child, &info, WEXITED | WNOWAIT) == -1) {
    waitpid(child, NULL, 0);
    return 3;
  }
  puts("zombie");
  fflush(stdout);
  getchar();
  return waitpid(child, NULL, 0) == child ? 0 : 4;
}
