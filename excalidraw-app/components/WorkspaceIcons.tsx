import type {
  FolderIconName,
  WorkspaceContextMenuIconName,
} from "./workspace-types";

export const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

export const GridIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  </svg>
);

export const ClockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className={filled ? "is-filled" : ""}
  >
    <path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />
  </svg>
);

export const FolderIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 6.5h6l2 2H20.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
  </svg>
);

export const MoreIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const FolderAppearanceIcon = ({ icon }: { icon: FolderIconName }) => {
  if (icon === "folder") {
    return <FolderIcon />;
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {icon === "book" && (
        <>
          <path d="M5 4.5h12a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z" />
          <path d="M5 4.5v13a2 2 0 0 0 2 2M9 8h6M9 11h6" />
        </>
      )}
      {icon === "palette" && (
        <>
          <path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.2a2 2 0 0 0 1.1-3.7 1.2 1.2 0 0 1 .7-2.2h1.4a4.1 4.1 0 0 0 4.1-4.1A8.5 8.5 0 0 0 12 3.5Z" />
          <circle cx="7.8" cy="10" r=".8" />
          <circle cx="11" cy="7.4" r=".8" />
          <circle cx="15" cy="8" r=".8" />
        </>
      )}
      {icon === "lightbulb" && (
        <>
          <path d="M9 18h6M10 21h4M8.6 14.5A6 6 0 1 1 15.4 14.5c-.8.6-1.4 1.4-1.4 2.5h-4c0-1.1-.6-1.9-1.4-2.5Z" />
          <path d="M12 2v1.5M4.9 4.9 6 6M19.1 4.9 18 6" />
        </>
      )}
      {icon === "layers" && (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      )}
      {icon === "star" && (
        <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
      )}
      {icon === "image" && (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m5 17 4.5-4 3.2 2.5 2.3-2 4 3.5" />
        </>
      )}
      {icon === "code" && <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-2-13-4 16" />}
      {icon === "bookmark" && (
        <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4V4.5Z" />
      )}
      {icon === "file" && (
        <>
          <path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3.5Z" />
          <path d="M14 3.5V8h4M9 12h6M9 16h6" />
        </>
      )}
      {icon === "tag" && (
        <>
          <path d="M20 13 13 20 3.5 10.5V4h6.5L20 13Z" />
          <circle cx="7.5" cy="8" r="1" />
        </>
      )}
      {icon === "heart" && (
        <path d="M20.8 8.8c0 5.1-8.8 10.3-8.8 10.3S3.2 13.9 3.2 8.8a4.5 4.5 0 0 1 8.8-1.3 4.5 4.5 0 0 1 8.8 1.3Z" />
      )}
      {icon === "compass" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m15.8 8.2-2.3 5.3-5.3 2.3 2.3-5.3 5.3-2.3Z" />
        </>
      )}
      {icon === "briefcase" && (
        <>
          <rect x="3.5" y="7" width="17" height="13" rx="2" />
          <path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M3.5 12h17M10 12v2h4v-2" />
        </>
      )}
    </svg>
  );
};

export const TrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

export const EmptyTrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M10 3h4a2 2 0 0 1 2 2v2H8V5a2 2 0 0 1 2-2Z" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export const EditIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

export const RestoreIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

export const BoardSelectionIcon = ({
  selected = false,
}: {
  selected?: boolean;
}) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className={selected ? "is-selected" : ""}
  >
    <circle cx="12" cy="12" r="9" />
    {selected && <path d="m8 12 2.5 2.5L16.5 9" />}
  </svg>
);

export const WorkspaceContextMenuIcon = ({
  icon,
}: {
  icon: WorkspaceContextMenuIconName;
}) => {
  if (icon === "star") {
    return <StarIcon />;
  }
  if (icon === "edit") {
    return <EditIcon />;
  }
  if (icon === "restore") {
    return <RestoreIcon />;
  }
  if (icon === "trash") {
    return <TrashIcon />;
  }
  if (icon === "check") {
    return <BoardSelectionIcon selected />;
  }
  if (icon === "search") {
    return <SearchIcon />;
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {icon === "open" && <path d="M7 17 17 7M8 7h9v9" />}
      {icon === "plus" && <path d="M12 5v14M5 12h14" />}
      {icon === "close" && <path d="m6 6 12 12M18 6 6 18" />}
      {icon === "folder" && (
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />
      )}
      {icon === "commands" && <path d="m5 7 5 5-5 5M13 17h6" />}
      {icon === "refresh" && (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M5.5 7a7.5 7.5 0 0 1 12-1L20 12M4 12l2.5 6a7.5 7.5 0 0 0 12-1" />
        </>
      )}
      {icon === "settings" && (
        <>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="8" cy="6" r="2" fill="currentColor" />
          <circle cx="16" cy="12" r="2" fill="currentColor" />
          <circle cx="10" cy="18" r="2" fill="currentColor" />
        </>
      )}
    </svg>
  );
};

export const ExcalidrawMark = () => (
  <div className="workspace-mark" aria-hidden="true">
    <img src="/brand-icon.jpg" alt="" width="512" height="512" />
  </div>
);
