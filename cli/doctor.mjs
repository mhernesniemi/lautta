import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lauttaVersion, STATE_FILE } from './init.mjs';
import { renderProject, sha } from './project.mjs';

/**
 * Compares the project's lautta files with the current templates. A file can differ because
 * the project changed it (drift) or because lautta's template moved on (an update to take).
 */
export function doctor(dir) {
	const statePath = join(dir, STATE_FILE);
	if (!existsSync(statePath)) throw new Error(`No ${STATE_FILE}: run lautta init first`);
	const state = JSON.parse(readFileSync(statePath, 'utf8'));
	const expected = renderProject(state.stack, state.values);

	let clean = true;
	for (const [path, content] of Object.entries(expected)) {
		const target = join(dir, path);
		if (!existsSync(target)) {
			console.log(`  missing   ${path}`);
			clean = false;
			continue;
		}
		const actual = sha(readFileSync(target, 'utf8'));
		if (actual === sha(content)) continue;
		clean = false;
		const reason =
			actual !== state.files[path]
				? 'changed in this project'
				: 'template updated: run lautta update';
		console.log(`  differs   ${path} (${reason})`);
	}

	for (const file of ['.node-version', 'pnpm-lock.yaml']) {
		if (!existsSync(join(dir, file))) {
			console.log(`  missing   ${file} (the pipeline needs it)`);
			clean = false;
		}
	}

	const pkgPath = join(dir, 'package.json');
	const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
	if (!pkg.packageManager?.startsWith('pnpm@')) {
		console.log('  missing   "packageManager": "pnpm@<version>" in package.json (pins pnpm everywhere)');
		clean = false;
	}

	console.log(clean ? '✓ Matches the lautta templates.' : '✗ See above.');
	return clean;
}

/**
 * Rewrites the files whose templates moved on, from the values saved at init. Files the
 * project changed are left alone and listed, to merge by hand.
 */
export function update(dir) {
	const statePath = join(dir, STATE_FILE);
	if (!existsSync(statePath)) throw new Error(`No ${STATE_FILE}: run lautta init first`);
	const state = JSON.parse(readFileSync(statePath, 'utf8'));
	const expected = renderProject(state.stack, state.values);

	for (const [path, content] of Object.entries(expected)) {
		const target = join(dir, path);
		const exists = existsSync(target);
		const actual = exists ? sha(readFileSync(target, 'utf8')) : undefined;
		if (actual === sha(content)) continue;
		if (exists && actual !== state.files[path]) {
			console.log(`  skipped   ${path} (changed in this project: merge by hand)`);
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
		state.files[path] = sha(content);
		console.log(`  updated   ${path}`);
	}
	state.lautta = lauttaVersion();
	writeFileSync(statePath, JSON.stringify(state, null, '\t') + '\n');
}
