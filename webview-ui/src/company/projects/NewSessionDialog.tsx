import type { ProjectStore } from './projectStore.js';

export interface NewSessionDialogProps { store: ProjectStore; nodeId: string; onClose: () => void; }
export function NewSessionDialog(props: NewSessionDialogProps) { void props; return <div role="dialog" aria-label="Phiên mới" />; }
