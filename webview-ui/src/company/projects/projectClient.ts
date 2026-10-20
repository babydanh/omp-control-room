import { transport } from '../../transport/index.js';
import { createProjectStore } from './projectStore.js';

export const projectStore = createProjectStore({ send: (message) => transport.send(message) });
