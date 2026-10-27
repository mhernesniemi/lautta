import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './render.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = join(ROOT, 'templates');

export const STACKS = readdirSync(TEMPLATES).filter((name) =>
	existsSync(join(TEMPLATES, name, 'stack.json'))
);

export function loadStack(name) {
	if (!STACKS.includes(name)) {
		throw new Error(`Unknown stack "${name}". Choose one of: ${STACKS.join(', ')}`);
	}
	return JSON.parse(readFileSync(join(TEMPLATES, name, 'stack.json'), 'utf8'));
}

export const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function listFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? listFiles(path) : [path];
	});
}

const yaml = (value) => JSON.stringify(String(value));
const lines = (items) => items.join('\n');

function envBlock(stack) {
	const clear = Object.entries({ NODE_ENV: 'production', ...stack.env });
	const out = ['  clear:', ...clear.map(([key, value]) => `    ${key}: ${yaml(value)}`)];
	if (stack.secrets.length) out.push('  secret:', ...stack.secrets.map((name) => `    - ${name}`));
	return lines(out);
}

const LITESTREAM_SECRETS = [
	'LITESTREAM_BUCKET',
	'LITESTREAM_ENDPOINT',
	'LITESTREAM_ACCESS_KEY_ID',
	'LITESTREAM_SECRET_ACCESS_KEY'
];

const secretNames = (stack) => [...stack.secrets, ...(stack.database ? LITESTREAM_SECRETS : [])];

// Storage keys are created by OpenTofu (infra/modules/project) into their own 1Password item,
// <service>-<environment>-infra, so applying never touches the secrets people typed in.
const INFRA_SECRETS = new Set([
	...LITESTREAM_SECRETS,
	'S3_BUCKET',
	'S3_ENDPOINT',
	'S3_REGION',
	'S3_ACCESS_KEY_ID',
	'S3_SECRET_ACCESS_KEY'
]);

const secretRefs = (stack, values, environment) =>
	lines(
		secretNames(stack).map((name) => {
			const item = `${values.service}-${environment}${INFRA_SECRETS.has(name) ? '-infra' : ''}`;
			return `${name}=op://${values.vault}/${item}/${name}`;
		})
	);

/** Everything a template can refer to, from the stack definition and the project's values. */
export function templateVars(stackName, values) {
	const stack = loadStack(stackName);
	const originEnv = (domain) =>
		lines(stack.originEnv.map((name) => `    ${name}: ${yaml(`https://${domain}`)}`));

	return {
		...values,
		stack: stackName,
		memory: stack.memory ?? '512m',
		health_path: stack.healthPath,
		database: stack.database ?? '',
		build_output: stack.buildOutput ?? '',
		start: JSON.stringify(stack.start ?? []),
		copy_lines: lines(
			(stack.copy ?? []).map((path) => `COPY --chown=node:node ${path} ./${path}`)
		),
		env_block: envBlock(stack),
		secret_env_lines: lines(secretNames(stack).map((name) => `${name}=$${name}`)),
		production_secret_refs: secretRefs(stack, values, 'production'),
		staging_secret_refs: secretRefs(stack, values, 'staging'),
		production_origin_env: originEnv(values.production_domain),
		staging_origin_env: originEnv(values.staging_domain)
	};
}

/**
 * The files lautta manages for a project, rendered: path → content. Empty renders (e.g. the
 * Litestream config of a stack without a database) are left out.
 */
export function renderProject(stackName, values) {
	const stack = loadStack(stackName);
	const vars = templateVars(stackName, values);
	const sources = [
		...listFiles(join(TEMPLATES, 'common')).map((path) => [
			relative(join(TEMPLATES, 'common'), path),
			path
		]),
		['Dockerfile', join(TEMPLATES, stack.dockerfile, 'Dockerfile')],
		...listFiles(join(TEMPLATES, stack.dockerfile, 'config')).map((path) => [
			relative(join(TEMPLATES, stack.dockerfile), path),
			path
		])
	];
	const files = {};
	for (const [target, source] of sources) {
		const content = render(readFileSync(source, 'utf8'), vars);
		if (content.trim()) files[target] = content;
	}
	return files;
}

/** App files the stack needs (e.g. a health route): written only when missing, never tracked. */
export function appFiles(stackName) {
	const stack = loadStack(stackName);
	return Object.entries(stack.appFiles ?? {}).map(([target, source]) => [
		target,
		readFileSync(join(TEMPLATES, stackName, source), 'utf8')
	]);
}
