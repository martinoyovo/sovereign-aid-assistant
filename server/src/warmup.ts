/**
 * Standalone warm-up script (`npm run warmup [modelName]`).
 *
 * Warms ONE model so the first on-stage question isn't delayed by a cold load.
 * It deliberately does NOT warm every installed model at once: a single large
 * model can be 20+ GB, and loading several together would exhaust RAM and slow
 * the whole machine. Pass a model name to warm a specific one; otherwise it
 * warms the preferred default (the same model the UI auto-selects).
 *
 *   npm run warmup                 # warm the default model
 *   npm run warmup -- gemma4:latest  # warm a specific model
 */

import { listModels, warmModel, ollamaHost } from "./ollama.js";

// Keep in sync with PREFERRED_MODELS in web/src/App.tsx and server/src/index.ts.
const PREFERRED_MODELS = ["qwen3.6", "qwen3", "qwen2.5", "llama3.1", "gemma4", "mistral-nemo", "llama3.2"];

function pickDefault(models: string[]): string {
  for (const pref of PREFERRED_MODELS) {
    const hit = models.find((m) => m === pref || m.startsWith(pref + ":"));
    if (hit) return hit;
  }
  return models[0];
}

async function main() {
  let models: string[] = [];
  try {
    models = await listModels();
  } catch {
    console.error("Could not reach Ollama. Is it running on localhost:11434?");
    process.exit(1);
  }
  if (models.length === 0) {
    console.warn("No models installed. Run e.g. `ollama pull qwen2.5` first.");
    return;
  }

  const requested = process.argv[2];
  const target = requested && models.includes(requested) ? requested : pickDefault(models);
  if (requested && !models.includes(requested)) {
    console.warn(`"${requested}" is not installed; warming "${target}" instead.`);
  }

  process.stdout.write(`Warming ${target} on ${ollamaHost()} ... `);
  try {
    await warmModel(target);
    console.log("ok");
  } catch {
    console.log("failed");
  }
}

main();
