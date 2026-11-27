import { buildCommand, simCommand, testCommand } from './commands.js';
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
const PLANNED_COMMANDS = ['erc', 'drc', 'export'] as const;

export function usage(): string {
  return [
    `triage ${TRIAGE_VERSION}`,
    '',
    'Usage: triage <command>',
    '',
    'Commands:',
    '  test [PROJECT] [--scenario FILE]… [--report FILE.json]',
    '              Run the scenarios in simulation/scenarios/ (exit 1 if one fails)',
    '  sim run [PROJECT] --scope NAME --for 5s [--set CONTROL=VALUE]… [--watch SIGNAL]…',
    '              Run a scope (whole-device, circuit, code, mechanism, a saved one)',
    '  sim scopes [PROJECT]',
    '              List the scopes',
    '  build [PROJECT] [--board PROFILE] [--fqbn FQBN]',
    "              Build the firmware with Triage's own Arduino engine (arduino-cli, built in)",
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
    case 'test':
    case 'sim':
    case 'build': {
      const commands = { test: testCommand, sim: simCommand, build: buildCommand };
      try {
        return commands[command](argv.slice(1));
      } catch (error) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `triage ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    }
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
