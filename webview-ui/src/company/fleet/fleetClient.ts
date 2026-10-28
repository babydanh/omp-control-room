import { transport } from '../../transport/index.js';
import { createFleetStore } from './fleetStore.js';

export const fleetStore = createFleetStore({ send: (message) => transport.send(message) });
