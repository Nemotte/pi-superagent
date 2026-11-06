// Public lightweight bootstrap contract. Importing it never loads the SDK or starts a service.
import { fileURLToPath } from 'node:url'
export { jobEnvironment as setupEnvironment } from './environment.js'
export { discoverWorkspace } from './repositories.js'
export const protocol = 1
export const supervisionProtocol = 1
export const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url))
export const setupPath = fileURLToPath(new URL('./setup-child.js', import.meta.url))
