import { createInterface } from 'node:readline/promises';

/** Questions in the terminal. `check` returns an error message, or nothing when the answer is fine. */
export function terminal() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const question = async (text) => {
		try {
			return (await rl.question(text)).trim();
		} catch {
			throw new Error('Cancelled, nothing written');
		}
	};

	return {
		async ask(label, fallback, check) {
			for (;;) {
				const answer = (await question(fallback ? `${label} (${fallback}): ` : `${label}: `)) || fallback || '';
				const error = check(answer);
				if (!error) return answer;
				console.log(`  ${error}`);
			}
		},
		async confirm(text) {
			return !/^n/i.test(await question(`${text} [Y/n] `));
		},
		close: () => rl.close()
	};
}
