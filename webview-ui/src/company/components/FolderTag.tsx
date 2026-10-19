import type { FolderIdentity } from '../folderIdentity.js';

interface FolderTagProps {
  identity: FolderIdentity;
  className?: string;
}

/**
 * A card's or attention item's folder: a colour dot and the folder's label. The dot uses the
 * folder's sidebar tick colour, so the two read as one folder.
 */
export function FolderTag({ identity, className = '' }: FolderTagProps) {
  return (
    <span
      title={identity.path}
      data-testid="folder-tag"
      className={`inline-flex min-w-0 max-w-full shrink items-center gap-1 text-2xs text-text-muted ${className}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: `var(--company-project-${identity.tone})` }}
      />
      <span className="min-w-0 truncate">{identity.label}</span>
    </span>
  );
}
