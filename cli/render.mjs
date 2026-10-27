// Placeholders are {{name}} (no spaces, so GitHub's ${{ expr }} passes through untouched).
// {{#name}}…{{/name}} keeps its content only when the value is truthy.
export function render(template, vars) {
	const withSections = template.replace(
		/\{\{#([a-z_]+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g,
		(_, name, body) => (vars[name] ? body : '')
	);
	return withSections.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => {
		if (!(name in vars)) throw new Error(`Template uses {{${name}}}, which has no value`);
		return String(vars[name] ?? '');
	});
}
