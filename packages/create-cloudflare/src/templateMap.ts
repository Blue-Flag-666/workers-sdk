import { runPagesGenerator } from "./pages";
import { runWorkersGenerator } from "./workers";
import type { C3Args } from "types";

type TemplateConfig = {
	label: string;
	handler: (args: C3Args) => Promise<void>;
	hidden?: boolean;
};

export const templateMap: Record<string, TemplateConfig> = {
	"hello-world": {
		label: `"Hello World" Worker`,
		handler: runWorkersGenerator,
	},
	"hello-world-durable-object": {
		label: `"Hello World" Durable Object`,
		handler: runWorkersGenerator,
	},
	webFramework: {
		label: "Website or web app",
		handler: runPagesGenerator,
	},
	common: {
		label: "Example router & proxy Worker",
		handler: runWorkersGenerator,
	},
	scheduled: {
		label: "Scheduled Worker (Cron Trigger)",
		handler: (args) => runWorkersGenerator({ ...args, deploy: false }),
	},
	queues: {
		label: "Queue consumer & producer Worker",
		handler: (args) => runWorkersGenerator({ ...args, deploy: false }),
	},
	chatgptPlugin: {
		label: `ChatGPT plugin`,
		handler: (args) =>
			runWorkersGenerator({
				...args,
				ts: true,
			}),
	},
	openapi: {
		label: `OpenAPI 3.1`,
		handler: (args) =>
			runWorkersGenerator({
				...args,
				ts: true,
			}),
	},
	"pre-existing": {
		label: "Pre-existing Worker (from Dashboard)",
		handler: runWorkersGenerator,
		hidden: true,
	},
};
