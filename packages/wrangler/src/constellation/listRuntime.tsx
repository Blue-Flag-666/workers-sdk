import { withConfig } from "../config";
import { logger } from "../logger";
import { requireAuth } from "../user";
import {
	asJson,
	type CommonYargsArgv,
	type StrictYargsOptionsToInterface,
} from "../yargs-types";
import { constellationBetaWarning, listRuntimes } from "./utils";

export function options(yargs: CommonYargsArgv) {
	return asJson(yargs).epilogue(constellationBetaWarning);
}

type HandlerOptions = StrictYargsOptionsToInterface<typeof options>;
export const handler = withConfig<HandlerOptions>(
	async ({ json, config }): Promise<void> => {
		const accountId = await requireAuth(config);
		const runtimes = await listRuntimes(accountId);

		if (json) {
			logger.log(JSON.stringify(runtimes, null, 2));
		} else {
			logger.log(constellationBetaWarning);
			logger.table(runtimes.map((runtime) => ({ name: runtime })));
		}
	}
);
