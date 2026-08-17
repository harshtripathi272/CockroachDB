/**
 * Lambda entry shim.
 *
 * AWS's Node 22 runtime has unreliable handler resolution for .ts entry files
 * (the module loader looks for <name>.js/<name>.mjs and does not always fall
 * back to type-stripping the .ts handler itself). This plain .mjs imports the
 * real handler from the .ts source — Node 22 strips types on that import — and
 * re-exports it under the name Lambda expects.
 *
 * Handler config: services/api/lambda-entry.handler
 */
import { handler } from './lambda.ts';

export { handler };
