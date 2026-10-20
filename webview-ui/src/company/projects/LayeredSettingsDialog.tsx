import type { ProjectStore } from './projectStore.js';

export interface LayeredSettingsDialogProps { store: ProjectStore; nodeId: string | null; onClose: () => void; }
export function LayeredSettingsDialog(props: LayeredSettingsDialogProps) { void props; return <div role="dialog" aria-label="Cài đặt theo tầng" />; }
