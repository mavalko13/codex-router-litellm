// This decision reads the model registry and user-model overlay, which in turn
// use runtime npm packages. Keep it out of install-plan.mjs: the latter is the
// bootstrap probe that must work in a freshly cloned checkout before npm ci.
import { localLiteLlmRequiredText } from "./local-litellm-mode.mjs";

process.stdout.write(`${localLiteLlmRequiredText()}\n`);
