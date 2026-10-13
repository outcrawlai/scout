/**
 * The models every example runs on, read from your environment. Scout has no
 * default model: you name one per role.
 *
 *   SCOUT_BASE_URL        your endpoint's base URL, the part before /chat/completions
 *   SCOUT_API_KEY         its key (leave empty for a local server that takes none)
 *   SCOUT_HANDS_MODEL     required: the model that reads the page and acts
 *   SCOUT_BRAIN_MODEL     optional: decides each step on long, multi-page tasks
 *   SCOUT_EYES_MODEL      optional: an image-capable model for questions about a screenshot
 *   SCOUT_EXTRACT_MODEL   optional: reads pages into your schema
 *
 * Any role can use its own endpoint with SCOUT_<ROLE>_BASE_URL and SCOUT_<ROLE>_API_KEY.
 */
import type { RoleModel, ScoutModels } from '@outcrawl/scout';

function role(name: 'HANDS' | 'BRAIN' | 'EYES' | 'EXTRACT'): RoleModel | undefined {
  const model = process.env[`SCOUT_${name}_MODEL`];
  if (model === undefined || model === '') return undefined;
  const baseURL = process.env[`SCOUT_${name}_BASE_URL`] ?? process.env['SCOUT_BASE_URL'];
  if (baseURL === undefined || baseURL === '') {
    throw new Error(`Set SCOUT_BASE_URL (or SCOUT_${name}_BASE_URL) to your endpoint, e.g. https://your-endpoint/v1`);
  }
  const apiKey = process.env[`SCOUT_${name}_API_KEY`] ?? process.env['SCOUT_API_KEY'] ?? '';
  return { model, baseURL, apiKey };
}

export function modelsFromEnv(): ScoutModels {
  const hands = role('HANDS');
  if (hands === undefined) {
    throw new Error('Set SCOUT_HANDS_MODEL to the model id your endpoint expects, e.g. SCOUT_HANDS_MODEL=your-model-id');
  }
  const brain = role('BRAIN');
  const eyes = role('EYES');
  const extract = role('EXTRACT');
  return {
    hands,
    ...(brain === undefined ? {} : { brain }),
    ...(eyes === undefined ? {} : { eyes }),
    ...(extract === undefined ? {} : { extract }),
  };
}

// Import proof (2026-10-13): this line must arrive here as scout-pr/N with this author.
