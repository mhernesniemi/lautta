// Renders every stack into <out>/<stack>/ with example values, for CI to lint and for reading.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderProject, STACKS } from '../cli/project.mjs';

const out = process.argv[2] ?? 'rendered';
for (const stack of STACKS) {
	const files = renderProject(stack, {
		service: `example-${stack}`,
		image: `example/${stack}`,
		vault: 'example',
		production_domain: 'www.example.fi',
		production_host: '203.0.113.10',
		staging_domain: `example-${stack}.staging.example.fi`,
		staging_host: '203.0.113.20',
		lautta_ref: 'v1'
	});
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(out, stack, path)), { recursive: true });
		writeFileSync(join(out, stack, path), content);
	}
}
console.log(`Rendered ${STACKS.join(', ')} into ${out}/`);
