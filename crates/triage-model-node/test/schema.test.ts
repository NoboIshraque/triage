import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './addon.js';

const schema = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'crates', 'triage-model', 'schema', 'triage.schema.json'),
    'utf8',
  ),
) as object;
const validate = new Ajv2020({ allErrors: true }).compile(schema);
const check = (toml: string) => validate(parse(toml));

describe('triage.toml JSON Schema (format 0)', () => {
  it('accepts the Smart Fan example', () => {
    const text = readFileSync(path.join(repoRoot, 'examples', 'smart-fan', 'triage.toml'), 'utf8');
    expect(check(text), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects what the Rust model rejects', () => {
    const minimal = '[project]\nname = "x"\nformat = 0\n';
    expect(check(minimal)).toBe(true);
    for (const bad of [
      '[project]\nname = "x"\nformat = 1\n',
      '[project]\nformat = 0\n',
      `${minimal}colour = "red"\n`,
      `${minimal}[firmware]\nbuild = "make"\n`,
      `${minimal}[firmware]\npath = "../outside"\n`,
      `${minimal}[firmware]\npath = "/abs"\n`,
      `${minimal}[firmware]\npath = "C:/abs"\n`,
      `${minimal}[firmware]\npath = "a\\\\b"\n`,
      `${minimal}[electronics]\nkicad_project = "a.sch"\n`,
      `${minimal}[mechanical]\ndocuments = ["a.step"]\n`,
    ]) {
      expect(check(bad), bad).toBe(false);
    }
  });
});
