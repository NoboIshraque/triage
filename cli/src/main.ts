import { TRIAGE_VERSION } from './version.js';

/** What a CLI invocation produced. `bin.ts` writes it to the process. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Exit code for a command line the CLI does not understand. */
export const EXIT_USAGE = 2;

/** Commands planned in PLAN §4.10. They arrive with their work packages. */
const PLANNED_COMMANDS = ['build', 'sim', 'test', 'erc', 'drc', 'export'] as const;

export function usage(): string {
  return [
    `triage ${TRIAGE_VERSION}`,
    '',
    'Usage: triage <command>',
    '',
    'Commands:',
    '  help        Show this help',
    '  version     Print the version',
    '',
    `Planned: ${PLANNED_COMMANDS.join(', ')}`,
    '',
  ].join('\n');
}

/** Runs the CLI on `argv` (the arguments after the program name) without side effects. */
export function run(argv: readonly string[]): CliResult {
  const [command] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { exitCode: 0, stdout: usage(), stderr: '' };
    case 'version':
    case '--version':
    case '-v':
      return { exitCode: 0, stdout: `triage ${TRIAGE_VERSION}\n`, stderr: '' };
    default: {
      const planned = (PLANNED_COMMANDS as readonly string[]).includes(command);
      const reason = planned ? 'is not available yet' : 'is not a triage command';
      return {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: `triage: '${command}' ${reason}\n\n${usage()}`,
      };
    }
  }
}
