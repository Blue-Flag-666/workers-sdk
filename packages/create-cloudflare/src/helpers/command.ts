import { existsSync, readdirSync, rmSync } from "fs";
import path, { join, resolve } from "path";
import { endSection, stripAnsi, warn } from "@cloudflare/cli";
import { brandColor, dim } from "@cloudflare/cli/colors";
import { isInteractive, spinner } from "@cloudflare/cli/interactive";
import { spawn } from "cross-spawn";
import { getFrameworkCli } from "frameworks/index";
import { fetch } from "undici";
import { quoteShellArgs } from "../common";
import { readFile, writeFile } from "./files";
import { detectPackageManager } from "./packages";
import type { PagesGeneratorContext } from "types";

/**
 * Command is a string array, like ['git', 'commit', '-m', '"Initial commit"']
 */
type Command = string[];

type RunOptions = {
	startText?: string;
	doneText?: string | ((output: string) => string);
	silent?: boolean;
	captureOutput?: boolean;
	useSpinner?: boolean;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** If defined this function is called to all you to transform the output from the command into a new string. */
	transformOutput?: (output: string) => string;
	/** If defined, this function is called to return a string that is used if the `transformOutput()` fails. */
	fallbackOutput?: (error: unknown) => string;
};

type MultiRunOptions = RunOptions & {
	commands: Command[];
	startText: string;
};

type PrintOptions<T> = {
	promise: Promise<T> | (() => Promise<T>);
	useSpinner?: boolean;
	startText: string;
	doneText?: string | ((output: T) => string);
};

export const runCommand = async (
	command: Command,
	opts: RunOptions = {}
): Promise<string> => {
	return printAsyncStatus({
		useSpinner: opts.useSpinner ?? opts.silent,
		startText: opts.startText || quoteShellArgs(command),
		doneText: opts.doneText,
		promise() {
			const [executable, ...args] = command;

			const cmd = spawn(executable, [...args], {
				// TODO: ideally inherit stderr, but npm install uses this for warnings
				// stdio: [ioMode, ioMode, "inherit"],
				stdio: opts.silent ? "pipe" : "inherit",
				env: {
					...process.env,
					...opts.env,
				},
				cwd: opts.cwd,
			});

			let output = ``;

			if (opts.captureOutput ?? opts.silent) {
				cmd.stdout?.on("data", (data) => {
					output += data;
				});
				cmd.stderr?.on("data", (data) => {
					output += data;
				});
			}

			return new Promise<string>((resolvePromise, reject) => {
				cmd.on("close", (code) => {
					try {
						if (code !== 0) {
							throw new Error(output, { cause: code });
						}

						// Process any captured output
						const transformOutput =
							opts.transformOutput ?? ((result: string) => result);
						const processedOutput = transformOutput(stripAnsi(output));

						// Send the captured (and processed) output back to the caller
						resolvePromise(processedOutput);
					} catch (e) {
						// Something went wrong.
						// Perhaps the command or the transform failed.
						// If there is a fallback use the result of calling that
						if (opts.fallbackOutput) {
							resolvePromise(opts.fallbackOutput(e));
						} else {
							reject(new Error(output, { cause: e }));
						}
					}
				});

				cmd.on("error", (code) => {
					reject(code);
				});
			});
		},
	});
};

// run multiple commands in sequence (not parallel)
export async function runCommands({ commands, ...opts }: MultiRunOptions) {
	return printAsyncStatus({
		useSpinner: opts.useSpinner ?? opts.silent,
		startText: opts.startText,
		doneText: opts.doneText,
		async promise() {
			const results = [];
			for (const command of commands) {
				results.push(await runCommand(command, { ...opts, useSpinner: false }));
			}
			return results.join("\n");
		},
	});
}

export const printAsyncStatus = async <T>({
	promise,
	...opts
}: PrintOptions<T>): Promise<T> => {
	let s: ReturnType<typeof spinner> | undefined;

	if (opts.useSpinner && isInteractive()) {
		s = spinner();
	}

	s?.start(opts?.startText);

	if (typeof promise === "function") {
		promise = promise();
	}

	try {
		const output = await promise;

		const doneText =
			typeof opts.doneText === "function"
				? opts.doneText(output)
				: opts.doneText;
		s?.stop(doneText);
	} catch (err) {
		s?.stop((err as Error).message);
	} finally {
		s?.stop();
	}

	return promise;
};

export const retry = async <T>(
	{
		times,
		exitCondition,
	}: { times: number; exitCondition?: (e: unknown) => boolean },
	fn: () => Promise<T>
) => {
	let error: unknown = null;
	while (times > 0) {
		try {
			return await fn();
		} catch (e) {
			error = e;
			times--;
			if (exitCondition?.(e)) {
				break;
			}
		}
	}
	throw error;
};

export const runFrameworkGenerator = async (
	ctx: PagesGeneratorContext,
	args: string[]
) => {
	const cli = getFrameworkCli(ctx, true);
	const { npm, dlx } = detectPackageManager();
	// yarn cannot `yarn create@some-version` and doesn't have an npx equivalent
	// So to retain the ability to lock versions we run it with `npx` and spoof
	// the user agent so scaffolding tools treat the invocation like yarn
	const cmd = [...(npm === "yarn" ? ["npx"] : dlx), cli, ...args];
	const env = npm === "yarn" ? { npm_config_user_agent: "yarn" } : {};

	if (ctx.framework?.args?.length) {
		cmd.push(...ctx.framework.args);
	}

	endSection(
		`Continue with ${ctx.framework?.config.displayName}`,
		`via \`${quoteShellArgs(cmd)}\``
	);

	if (process.env.VITEST) {
		const flags = ctx.framework?.config.testFlags ?? [];
		cmd.push(...flags);
	}

	await runCommand(cmd, { env });
};

type InstallConfig = {
	startText?: string;
	doneText?: string;
	dev?: boolean;
};

export const installPackages = async (
	packages: string[],
	config: InstallConfig
) => {
	const { npm } = detectPackageManager();

	let saveFlag;
	let cmd;
	switch (npm) {
		case "yarn":
			cmd = "add";
			saveFlag = config.dev ? "-D" : "";
			break;
		case "bun":
			cmd = "add";
			saveFlag = config.dev ? "-d" : "";
			break;
		case "npm":
		case "pnpm":
		default:
			cmd = "install";
			saveFlag = config.dev ? "--save-dev" : "--save";
			break;
	}

	await runCommand([npm, cmd, saveFlag, ...packages], {
		...config,
		silent: true,
	});
};

// Resets the package manager context for a project by clearing out existing dependencies
// and lock files then re-installing.
// This is needed in situations where npm is automatically used by framework creators for the initial
// install, since using other package managers in a folder with an existing npm install will cause failures
// when installing subsequent packages
export const resetPackageManager = async (ctx: PagesGeneratorContext) => {
	const { npm } = detectPackageManager();

	if (!needsPackageManagerReset(ctx)) {
		return;
	}

	const nodeModulesPath = path.join(ctx.project.path, "node_modules");
	if (existsSync(nodeModulesPath)) rmSync(nodeModulesPath, { recursive: true });

	const lockfilePath = path.join(ctx.project.path, "package-lock.json");
	if (existsSync(lockfilePath)) rmSync(lockfilePath);

	await runCommand([npm, "install"], {
		silent: true,
		cwd: ctx.project.path,
		startText: "Installing dependencies",
		doneText: `${brandColor("installed")} ${dim(`via \`${npm} install\``)}`,
	});
};

const needsPackageManagerReset = (ctx: PagesGeneratorContext) => {
	const { npm } = detectPackageManager();
	const projectPath = ctx.project.path;

	switch (npm) {
		case "npm":
			return false;
		case "yarn":
			return !existsSync(path.join(projectPath, "yarn.lock"));
		case "pnpm":
			return !existsSync(path.join(projectPath, "pnpm-lock.yaml"));
		case "bun":
			return !existsSync(path.join(projectPath, "bun.lockb"));
	}
};

export const npmInstall = async () => {
	const { npm } = detectPackageManager();

	await runCommand([npm, "install"], {
		silent: true,
		startText: "Installing dependencies",
		doneText: `${brandColor("installed")} ${dim(`via \`${npm} install\``)}`,
	});
};

export const installWrangler = async () => {
	const { npm } = detectPackageManager();

	// Exit early if already installed
	if (existsSync(path.resolve("node_modules", "wrangler"))) {
		return;
	}

	await installPackages([`wrangler`], {
		dev: true,
		startText: `Installing wrangler ${dim(
			"A command line tool for building Cloudflare Workers"
		)}`,
		doneText: `${brandColor("installed")} ${dim(
			`via \`${npm} install wrangler --save-dev\``
		)}`,
	});
};

export const isLoggedIn = async () => {
	const { npx } = detectPackageManager();
	try {
		const output = await runCommand([npx, "wrangler", "whoami"], {
			silent: true,
		});
		return /You are logged in/.test(output);
	} catch (error) {
		return false;
	}
};

export const wranglerLogin = async () => {
	const { npx } = detectPackageManager();

	const s = spinner();
	s.start(`Logging into Cloudflare ${dim("checking authentication status")}`);
	const alreadyLoggedIn = await isLoggedIn();
	s.stop(brandColor(alreadyLoggedIn ? "logged in" : "not logged in"));
	if (alreadyLoggedIn) return true;

	s.start(`Logging into Cloudflare ${dim("This will open a browser window")}`);

	// We're using a custom spinner since this is a little complicated.
	// We want to vary the done status based on the output
	const output = await runCommand([npx, "wrangler", "login"], {
		silent: true,
	});
	const success = /Successfully logged in/.test(output);

	const verb = success ? "allowed" : "denied";
	s.stop(`${brandColor(verb)} ${dim("via `wrangler login`")}`);

	return success;
};

export const listAccounts = async () => {
	const { npx } = detectPackageManager();

	const output = await runCommand([npx, "wrangler", "whoami"], {
		silent: true,
	});

	const accounts: Record<string, string> = {};
	output.split("\n").forEach((line) => {
		const match = line.match(/│\s+(.+)\s+│\s+(\w{32})\s+│/);
		if (match) {
			accounts[match[1].trim()] = match[2].trim();
		}
	});

	return accounts;
};

/**
 * Look up the latest release of workerd and use its date as the compatibility_date
 * configuration value for wrangler.toml.
 *
 * If the look up fails then we fall back to a well known date.
 *
 * The date is extracted from the version number of the workerd package tagged as `latest`.
 * The format of the version is `major.yyyymmdd.patch`.
 *
 * @returns The latest compatibility date for workerd in the form "YYYY-MM-DD"
 */
export async function getWorkerdCompatibilityDate() {
	const { compatDate: workerdCompatibilityDate } = await printAsyncStatus<{
		compatDate: string;
		isFallback: boolean;
	}>({
		useSpinner: true,
		startText: "Retrieving current workerd compatibility date",
		doneText: ({ compatDate, isFallback }) =>
			`${brandColor("compatibility date")}${
				isFallback ? dim(" Could not find workerd date, falling back to") : ""
			} ${dim(compatDate)}`,
		async promise() {
			try {
				const resp = await fetch("https://registry.npmjs.org/workerd");
				const workerdNpmInfo = (await resp.json()) as {
					"dist-tags": { latest: string };
				};
				const result = workerdNpmInfo["dist-tags"].latest;

				// The format of the workerd version is `major.yyyymmdd.patch`.
				const match = result.match(/\d+\.(\d{4})(\d{2})(\d{2})\.\d+/);

				if (match) {
					const [, year, month, date] = match ?? [];
					return { compatDate: `${year}-${month}-${date}`, isFallback: false };
				}
			} catch {}

			return { compatDate: "2023-05-18", isFallback: true };
		},
	});

	return workerdCompatibilityDate;
}

export async function installWorkersTypes(ctx: PagesGeneratorContext) {
	const { npm } = detectPackageManager();

	await installPackages(["@cloudflare/workers-types"], {
		dev: true,
		startText: `Installing @cloudflare/workers-types`,
		doneText: `${brandColor("installed")} ${dim(`via ${npm}`)}`,
	});
	await addWorkersTypesToTsConfig(ctx);
}

// @cloudflare/workers-types are versioned by compatibility dates, so we must look
// up the latest entrypoint from the installed dependency on disk.
// See also https://github.com/cloudflare/workerd/tree/main/npm/workers-types#compatibility-dates
export function getLatestTypesEntrypoint(ctx: PagesGeneratorContext) {
	const workersTypesPath = resolve(
		ctx.project.path,
		"node_modules",
		"@cloudflare",
		"workers-types"
	);

	try {
		const entrypoints = readdirSync(workersTypesPath);

		const sorted = entrypoints
			.filter((filename) => filename.match(/(\d{4})-(\d{2})-(\d{2})/))
			.sort()
			.reverse();

		if (sorted.length === 0) {
			return null;
		}

		return sorted[0];
	} catch (error) {
		return null;
	}
}

export async function addWorkersTypesToTsConfig(ctx: PagesGeneratorContext) {
	const tsconfigPath = join(ctx.project.path, "tsconfig.json");
	if (!existsSync(tsconfigPath)) {
		return;
	}

	const s = spinner();
	s.start(`Adding latest types to \`tsconfig.json\``);

	const tsconfig = readFile(tsconfigPath);
	const entrypointVersion = getLatestTypesEntrypoint(ctx);
	if (entrypointVersion === null) {
		s.stop(
			`${brandColor(
				"skipped"
			)} couldn't find latest compatible version of @cloudflare/workers-types`
		);
		return;
	}

	const typesEntrypoint = `@cloudflare/workers-types/${entrypointVersion}`;

	let updated = tsconfig;

	if (tsconfig.includes("@cloudflare/workers-types")) {
		updated = tsconfig.replace("@cloudflare/workers-types", typesEntrypoint);
	} else {
		try {
			// Note: this simple implementation doesn't handle tsconfigs containing comments
			//       (as it is not needed for the existing use cases)
			const tsConfigJson = JSON.parse(tsconfig);
			tsConfigJson.compilerOptions ??= {};
			tsConfigJson.compilerOptions.types = [
				...(tsConfigJson.compilerOptions.types ?? []),
				typesEntrypoint,
			];
			updated = JSON.stringify(tsConfigJson, null, 2);
		} catch {
			warn("Could not parse tsconfig.json file");
			updated = tsconfig;
		}
	}

	writeFile(tsconfigPath, updated);
	s.stop(`${brandColor("added")} ${dim(typesEntrypoint)}`);
}
