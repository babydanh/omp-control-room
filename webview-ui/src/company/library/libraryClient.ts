import { transport } from '../../transport/index.js';
import { createLibraryStore } from './libraryStore.js';

export const libraryStore = createLibraryStore({ send: (message) => transport.send(message) });
