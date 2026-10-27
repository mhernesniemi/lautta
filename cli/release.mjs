import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

// Plain git only, with no pager, so the output stays in the terminal's scrollback.
const git = (...args) =>
	execFileSync('git', args, {
		encoding: 'utf8',
		env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' }
	}).trim();

const tryGit = (...args) => {
	try {
		return git(...args);
	} catch {
		return '';
	}
};

export function nextTag(existing, today = new Date()) {
	const base = `v${today.toISOString().slice(0, 10).replaceAll('-', '.')}`;
	let tag = base;
	for (let n = 2; existing.includes(tag); n++) tag = `${base}.${n}`;
	return tag;
}

/**
 * Tags the current main as vYYYY.MM.DD (".2" etc. for later releases that day) and pushes the
 * tag. The pipeline then promotes the image main built and tested to production.
 */
export async function release({ yes, 'dry-run': dryRun }) {
	if (git('branch', '--show-current') !== 'main') throw new Error('Switch to main first.');
	if (git('status', '--porcelain')) throw new Error('Commit or stash your changes first.');
	git('fetch', '-q', 'origin', 'main', '--tags');
	if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
		throw new Error("Your main differs from GitHub's. Push or pull first.");
	}

	const last = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*');
	if (last && git('rev-list', '-n1', last) === git('rev-parse', 'HEAD')) {
		throw new Error(`This commit is already released as ${last}.`);
	}
	const tag = nextTag(git('tag', '--list', 'v*').split('\n'));
	const short = git('rev-parse', '--short', 'HEAD');

	console.log(`Release ${tag} (${short}), changes since ${last || 'the first commit'}:`);
	console.log(git('log', '--max-count=40', '--format=  - %s', ...(last ? [`${last}..HEAD`] : [])));
	if (dryRun) {
		console.log('(dry run: nothing created)');
		return;
	}
	if (!yes) {
		const prompt = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await prompt.question(`Release and deploy ${tag} to production? [y/N] `);
		prompt.close();
		if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Cancelled.');
	}

	git('tag', '-a', tag, '-m', `Release ${tag}`);
	git('push', '-q', 'origin', tag);

	const repo = git('remote', 'get-url', 'origin')
		.replace(/^git@github\.com:/, 'https://github.com/')
		.replace(/\.git$/, '');
	console.log(
		`✓ Released ${tag}. It deploys once the pipeline has passed for ${short}: ${repo}/actions`
	);
}
