import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appFiles, loadStack, renderProject, ROOT, sha } from './project.mjs';

export const STATE_FILE = '.lautta/project.json';

const REQUIRED = ['stack', 'production-domain', 'production-host', 'staging-domain', 'staging-host'];

/** owner/repo from the origin remote (https or ssh), lowercased as registries require. */
function imageFromGit(dir) {
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
		const match = /github\.com[:/](.+?)(?:\.git)?\s*$/.exec(url);
		return match?.[1].toLowerCase();
	} catch {
		return undefined;
	}
}

export function lauttaVersion() {
	return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * Adds `pnpm release`, the stack's scripts and the lautta dev dependency, keeping the file's
 * indentation. Existing scripts win.
 */
function updatePackageJson(dir, ref, scripts) {
	const path = join(dir, 'package.json');
	if (!existsSync(path)) return;
	const text = readFileSync(path, 'utf8');
	const indent = /^(\s+)"/m.exec(text)?.[1] ?? '\t';
	const pkg = JSON.parse(text);
	pkg.scripts ??= {};
	for (const [name, command] of Object.entries({ release: 'lautta release', ...scripts })) {
		pkg.scripts[name] ??= command;
	}
	pkg.devDependencies ??= {};
	pkg.devDependencies.lautta ??= `github:mhernesniemi/lautta#${ref}`;
	writeFileSync(path, JSON.stringify(pkg, null, indent) + '\n');
}

export function init(dir, options) {
	const missing = REQUIRED.filter((name) => !options[name]);
	if (missing.length) throw new Error(`Missing ${missing.map((name) => `--${name}`).join(', ')}`);

	const image = options.image ?? imageFromGit(dir);
	if (!image) throw new Error('No GitHub origin remote to name the image after; pass --image owner/repo');
	const service = options.service ?? image.split('/').pop();
	if (!/^[a-z0-9][a-z0-9-]*$/.test(service)) {
		throw new Error(`Service "${service}" must be lowercase letters, digits and dashes`);
	}

	const ref = options['lautta-ref'] ?? 'v1';
	const values = {
		service,
		image,
		vault: options.vault ?? service,
		production_domain: options['production-domain'],
		production_host: options['production-host'],
		staging_domain: options['staging-domain'],
		staging_host: options['staging-host'],
		lautta_ref: ref
	};
	const files = renderProject(options.stack, values);

	const clashes = Object.keys(files).filter((path) => existsSync(join(dir, path)));
	if (clashes.length && !options.force) {
		throw new Error(`These files exist already (use --force to overwrite):\n  ${clashes.join('\n  ')}`);
	}

	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
		console.log(`  wrote ${path}`);
	}
	for (const [path, content] of appFiles(options.stack)) {
		if (existsSync(join(dir, path))) continue;
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
		console.log(`  wrote ${path}`);
	}
	updatePackageJson(dir, ref, loadStack(options.stack).scripts);

	const state = {
		lautta: lauttaVersion(),
		stack: options.stack,
		values,
		files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha(content)]))
	};
	mkdirSync(join(dir, '.lautta'), { recursive: true });
	writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, '\t') + '\n');

	console.log(`
✓ ${service} is set up for the ${options.stack} stack. Next:
  1. In 1Password, create the items ${service}-production and ${service}-staging in the
     "${values.vault}" vault, with a field for each name in .lautta/secrets.production.
  2. Give the repository the secret OP_SERVICE_ACCOUNT_TOKEN (a service account that can read
     that vault and the shared "lautta" vault).
  3. Run pnpm install, commit, and push to main: the pipeline deploys staging.`);
}
