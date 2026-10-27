#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { init } from './init.mjs';
import { doctor, update } from './doctor.mjs';
import { release } from './release.mjs';
import { STACKS } from './project.mjs';

const HELP = `lautta: build, ship and run client web apps on UpCloud

Usage:
  lautta init --stack <stack> --production-domain <domain> --production-host <ip>
              --staging-domain <domain> --staging-host <ip> [--service <name>]
              [--vault <1password vault>] [--image <owner/repo>] [--force]
  lautta doctor           Compare this project's lautta files with the templates
  lautta update           Take template updates for the files this project hasn't changed
  lautta release          Tag main as a release (vYYYY.MM.DD) and deploy it to production
                          [--yes] [--dry-run]

Stacks: ${STACKS.join(', ')}`;

const [command, ...rest] = process.argv.slice(2);

try {
	switch (command) {
		case 'init': {
			const { values } = parseArgs({
				args: rest,
				options: {
					stack: { type: 'string' },
					service: { type: 'string' },
					'production-domain': { type: 'string' },
					'production-host': { type: 'string' },
					'staging-domain': { type: 'string' },
					'staging-host': { type: 'string' },
					vault: { type: 'string' },
					image: { type: 'string' },
					'lautta-ref': { type: 'string' },
					force: { type: 'boolean', default: false }
				}
			});
			init(process.cwd(), values);
			break;
		}
		case 'doctor':
			process.exitCode = doctor(process.cwd()) ? 0 : 1;
			break;
		case 'update':
			update(process.cwd());
			break;
		case 'release': {
			const { values } = parseArgs({
				args: rest,
				options: {
					yes: { type: 'boolean', default: false },
					'dry-run': { type: 'boolean', default: false }
				}
			});
			await release(values);
			break;
		}
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			console.log(HELP);
			break;
		default:
			console.error(`Unknown command "${command}".\n\n${HELP}`);
			process.exitCode = 2;
	}
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
}
