import { transport } from '../../transport/index.js';
import { createProjectStore } from './projectStore.js';
import { readTreeCache, writeTreeCache } from './projectTreeCache.js';

export const projectStore = createProjectStore({ send: (message) => transport.send(message), restoreNodes: readTreeCache(), saveNodes: writeTreeCache });
