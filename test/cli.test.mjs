import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { doctor, update } from '../cli/doctor.mjs';
import { init } from '../cli/init.mjs';
import { renderProject, sha, STACKS } from '../cli/project.mjs';
import { nextTag } from '../cli/release.mjs';
import { render } from '../cli/render.mjs';

const values = {
	service: 'client-site',
	image: 'acme/client-site',
	vault: 'client',
	production_domain: 'www.client.fi',
	production_host: '203.0.113.10',
	staging_domain: 'client-site.staging.example.fi',
	staging_host: '203.0.113.20',
	lautta_ref: 'v1'
};

const options = {
	stack: 'hoikka',
	service: 'client-shop',
	image: 'acme/client-shop',
	vault: 'client',
	'production-domain': 'shop.client.fi',
	'production-host': '203.0.113.10',
	'staging-domain': 'client-shop.staging.example.fi',
	'staging-host': '203.0.113.20'
};

const quietly = (fn) => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test('render fills placeholders and sections, and leaves GitHub expressions alone', () => {
	const out = render('a {{x}}\n{{#on}}yes\n{{/on}}{{#off}}no\n{{/off}}${{ github.ref }}', {
		x: 1,
		on: true,
		off: ''
	});
	assert.equal(out, 'a 1\nyes\n${{ github.ref }}');
	assert.throws(() => render('{{missing}}', {}), /missing/);
});

for (const stack of STACKS) {
	test(`${stack}: every template renders completely`, () => {
		const files = renderProject(stack, values);
		for (const [path, content] of Object.entries(files)) {
			assert.doesNotMatch(content, /\{\{[#/]?[a-z_]+\}\}/, `${path} has an unfilled placeholder`);
		}
		assert.ok(files['config/deploy.yml'].includes('service: client-site'));
		assert.ok(files.Dockerfile);
	});
}

test('stacks without a database get no backups', () => {
	const files = renderProject('astro-static', values);
	assert.equal(files['config/litestream.yml'], undefined);
	assert.doesNotMatch(files['config/deploy.yml'], /litestream|volumes/);
	assert.ok(files['config/Caddyfile']);
});

test('stacks with a database stream it to Object Storage', () => {
	const files = renderProject('kide', values);
	assert.match(files['config/deploy.yml'], /DATABASE_FILE: cms\.db/);
	assert.match(files['.lautta/secrets.production'], /LITESTREAM_BUCKET=op:\/\/client\/client-site-production-infra\//);
	assert.match(files['.lautta/secrets.production'], /KIDE_AUTH_SECRET=op:\/\/client\/client-site-production\//);
	assert.match(files['config/deploy.production.yml'], /CMS_TRUSTED_ORIGIN: "https:\/\/www\.client\.fi"/);
});

test('init writes the files, doctor sees drift, update takes template changes', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lautta-'));
	writeFileSync(join(dir, 'package.json'), '{\n  "name": "x"\n}\n');
	writeFileSync(join(dir, '.node-version'), '22\n');
	writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
	quietly(() => init(dir, options));

	const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	assert.equal(pkg.scripts.release, 'lautta release');
	assert.equal(pkg.devDependencies.lautta, 'github:mhernesniemi/lautta#v1');
	assert.throws(() => quietly(() => init(dir, options)), /exist already/);
	assert.equal(quietly(() => doctor(dir)), true);

	// The project changed the Dockerfile; deploy.yml still matches an older template.
	writeFileSync(join(dir, 'Dockerfile'), 'changed\n');
	writeFileSync(join(dir, 'config/deploy.yml'), 'older template\n');
	const statePath = join(dir, '.lautta/project.json');
	const state = JSON.parse(readFileSync(statePath, 'utf8'));
	state.files['config/deploy.yml'] = sha('older template\n');
	writeFileSync(statePath, JSON.stringify(state));
	assert.equal(quietly(() => doctor(dir)), false);

	quietly(() => update(dir));
	assert.match(readFileSync(join(dir, 'config/deploy.yml'), 'utf8'), /service: client-shop/);
	assert.equal(readFileSync(join(dir, 'Dockerfile'), 'utf8'), 'changed\n');
});

test('release tags count up within a day', () => {
	const day = new Date('2026-10-27T12:00:00Z');
	assert.equal(nextTag([], day), 'v2026.10.27');
	assert.equal(nextTag(['v2026.10.27'], day), 'v2026.10.27.2');
	assert.equal(nextTag(['v2026.10.27', 'v2026.10.27.2'], day), 'v2026.10.27.3');
});
