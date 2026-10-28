import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { terminal } from './ask.mjs';
import { appFiles, loadStack, renderProject, ROOT, sha, STACKS } from './project.mjs';

export const STATE_FILE = '.lautta/project.json';

const SERVICE = /^[a-z0-9][a-z0-9-]*$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;

const QUESTIONS = [
	{
		name: 'stack',
		label: 'Stack',
		check: (v) => (STACKS.includes(v) ? null : `Choose one of: ${STACKS.join(', ')}`)
	},
	{
		name: 'service',
		label: 'Service name',
		check: (v) => (SERVICE.test(v) ? null : 'Use lowercase letters, digits and dashes, e.g. acme-shop')
	},
	{ name: 'vault', label: '1Password vault', check: (v) => (v ? null : "Name the client's vault, e.g. acme") },
	{ name: 'production-domain', label: 'Production domain', check: (v) => domain(v, 'shop.acme.fi') },
	{ name: 'production-host', label: 'Production server IP', check: ip },
	{ name: 'staging-domain', label: 'Staging domain', check: (v) => domain(v, 'acme-shop.staging.example.fi') },
	{ name: 'staging-host', label: 'Staging server IP', check: ip }
];

function domain(value, example) {
	return DOMAIN.test(value) ? null : `Enter a domain without https://, e.g. ${example}`;
}

function ip(value) {
	return IPV4.test(value) ? null : 'Enter an IPv4 address, e.g. 203.0.113.10 (tofu output hosts in the fleet repo)';
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

/** The stack this project looks like, from its files and dependencies. */
export function detectStack(dir) {
	if (existsSync(join(dir, 'hoikka.config.ts'))) return 'hoikka';
	const pkg = readJson(join(dir, 'package.json')) ?? {};
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	if (deps['@kidecms/core'] || existsSync(join(dir, 'src/cms/cms.config.ts'))) return 'kide';
	if (deps['@sveltejs/kit']) return 'sveltekit';
	if (deps.astro) return 'astro-static';
}

// Servers and the staging domain are usually the same across projects, so the terminal suggests the last answers.
const LAST_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'lautta', 'last.json');

function rememberAnswers(options) {
	const suffix = options['staging-domain'].split('.').slice(1).join('.');
	mkdirSync(dirname(LAST_FILE), { recursive: true });
	writeFileSync(
		LAST_FILE,
		JSON.stringify({
			'production-host': options['production-host'],
			'staging-host': options['staging-host'],
			'staging-suffix': suffix
		}) + '\n'
	);
}

/**
 * Fills in what the flags left out: detected values without asking, the rest from `ask` when given.
 * Without `ask` (no terminal, or --yes), anything still missing is an error that shows the full command.
 */
export async function resolveOptions(dir, options, ask) {
	const image = options.image ?? imageFromGit(dir);
	if (!image) throw new Error('No GitHub origin remote to name the image after; add one or pass --image owner/repo');

	const last = ask ? (readJson(LAST_FILE) ?? {}) : {};
	const resolved = { ...options, image };
	const suggest = {
		stack: () => detectStack(dir),
		service: () => image.split('/').pop(),
		'production-host': () => last['production-host'],
		'staging-domain': () => last['staging-suffix'] && `${resolved.service}.${last['staging-suffix']}`,
		'staging-host': () => last['staging-host']
	};
	const detected = new Set(['stack', 'service']);

	const missing = [];
	for (const { name, label, check } of QUESTIONS) {
		if (resolved[name]) {
			const error = check(resolved[name]);
			if (error) throw new Error(`--${name} "${resolved[name]}": ${error}`);
			continue;
		}
		const fallback = suggest[name]?.();
		if (ask) resolved[name] = await ask(label, fallback, check);
		else if (fallback && detected.has(name)) resolved[name] = fallback;
		else missing.push(name);
	}

	if (missing.length) {
		const flags = QUESTIONS.map(({ name }) => `--${name} ${resolved[name] ?? `<${name}>`}`);
		throw new Error(
			`Missing ${missing.map((name) => `--${name}`).join(', ')}. Run it in a terminal to be asked, or pass every value:\n` +
				`  lautta init ${flags.join(' \\\n    ')}`
		);
	}
	return resolved;
}

/** `lautta init`: asks for what's missing when there's a terminal, then writes the project's files. */
export async function runInit(dir, options, { interactive }) {
	if (existsSync(join(dir, STATE_FILE)) && !options.force) {
		throw new Error('This project is set up already: run lautta doctor or lautta update (or init --force to start over)');
	}
	const term = interactive ? terminal() : undefined;
	try {
		const resolved = await resolveOptions(dir, options, term?.ask);
		if (term && !(await term.confirm(`Set up ${resolved.service} for the ${resolved.stack} stack?`))) {
			console.log('Nothing written.');
			return;
		}
		init(dir, resolved);
		if (term) rememberAnswers(resolved);
	} finally {
		term?.close();
	}
}

const REQUIRED = QUESTIONS.map(({ name }) => name);

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
	if (!SERVICE.test(service)) {
		throw new Error(`Service "${service}" must be lowercase letters, digits and dashes`);
	}

	const ref = options['lautta-ref'] ?? 'v1';
	const values = {
		service,
		image,
		vault: options.vault,
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
	if (!existsSync(join(dir, '.node-version'))) {
		const nvmrc = join(dir, '.nvmrc');
		writeFileSync(join(dir, '.node-version'), existsSync(nvmrc) ? readFileSync(nvmrc, 'utf8') : '22\n');
		console.log('  wrote .node-version');
	}

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
  1. In 1Password's "${values.vault}" vault, create the items ${service}-production and
     ${service}-staging with a field for each name in .lautta/secrets.<environment> that points
     to them. The *-infra items come from OpenTofu (the project module).
  2. Give the repository the secret OP_SERVICE_ACCOUNT_TOKEN (a service account that can read
     that vault and the shared "lautta" vault).
  3. Run pnpm install, commit, and push to main: the pipeline deploys staging.`);
}
