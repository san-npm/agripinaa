/** Print one required runner wallet filename per line for deployment preflight. */
import { requiredRunnerWalletFiles } from './agent-config';

process.stdout.write(`${requiredRunnerWalletFiles().join('\n')}\n`);
