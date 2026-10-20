import type { ProjectStore } from './projectStore.js';

export interface ChangesPageProps { store: ProjectStore; checkoutId: string; onClose: () => void; }
export function ChangesPage(props: ChangesPageProps) { void props; return <main aria-label="Thay đổi" />; }
