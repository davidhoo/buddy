import { runBuddyCli } from './buddy/cli'
import { fixShellPath } from './buddy/shell-path'

fixShellPath()

void runBuddyCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
