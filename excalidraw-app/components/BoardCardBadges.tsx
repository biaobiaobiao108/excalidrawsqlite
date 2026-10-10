import React, { useLayoutEffect, useRef, useState } from "react";

/** Fit complete badges in one row; never truncate a tag's text. */
export const BoardCardBadges = ({ tags, folderName, folderIcon, folderColor }: {
  tags: readonly string[];
  folderName?: string | null;
  folderIcon: React.ReactNode;
  folderColor: string;
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ visible: [] as number[], compactFolder: false });

  useLayoutEffect(() => {
    const row = rowRef.current, probe = probeRef.current;
    if (!row || !probe) return;
    const measure = () => {
      const width = row.clientWidth;
      if (!width) return;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const tagWidths = [...probe.querySelectorAll<HTMLElement>(".board-card-tag")]
        .map((badge) => badge.getBoundingClientRect().width);
      const moreWidths = [...probe.querySelectorAll<HTMLElement>(".board-card-tag-more")]
        .map((badge) => badge.getBoundingClientRect().width);
      const folderWidths = [...probe.querySelectorAll<HTMLElement>(".board-card-folder")]
        .map((badge) => badge.getBoundingClientRect().width);
      const compactFolder = Boolean(folderName && folderWidths[0] +
        (tags.length ? gap + moreWidths[tags.length - 1] : 0) > width);
      let used = folderName ? folderWidths[compactFolder ? 1 : 0] : 0;
      let occupied = Boolean(folderName);
      const visible: number[] = [];
      // If everything fits, the overflow counter needs no reserved space.
      const allWidth = used + tagWidths.reduce((sum, value) => sum + value, 0) +
        gap * Math.max(0, tagWidths.length + Number(occupied) - 1);
      if (allWidth <= width) {
        visible.push(...tags.map((_, index) => index));
      } else {
        for (const [index, tagWidth] of tagWidths.entries()) {
          const remaining = tags.length - visible.length - 1;
          const nextWidth = used + (occupied ? gap : 0) + tagWidth;
          const counterWidth = remaining ? gap + moreWidths[remaining - 1] : 0;
          if (nextWidth + counterWidth > width) continue;
          visible.push(index);
          used = nextWidth;
          occupied = true;
        }
      }
      setLayout((current) => current.compactFolder === compactFolder &&
        current.visible.length === visible.length && current.visible.every((index, i) => index === visible[i])
        ? current : { visible, compactFolder });
    };
    measure();
    // Measuring the probe also catches font changes, not just card resizes.
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [tags, folderName]);

  const visible = new Set(layout.visible);
  const hiddenTags = tags.filter((_, index) => !visible.has(index));
  const folder = (compact = false) => (
    <span className="board-card-badge board-card-folder"
      title={`所属文件夹：${folderName}`} aria-label={`所属文件夹：${folderName}`}
      style={{ "--folder-accent": folderColor } as React.CSSProperties}>
      {folderIcon}{!compact && folderName}
    </span>
  );
  const tag = (text: string) => <span key={text} className="board-card-badge board-card-tag" title={text}>{text}</span>;
  return (
    <div ref={rowRef} className="board-card-badges">
      {folderName && folder(layout.compactFolder)}
      {layout.visible.map((index) => tag(tags[index]))}
      {hiddenTags.length > 0 && <span className="board-card-badge board-card-tag-more"
        title={`更多标签：${hiddenTags.join("、")}`} aria-label={`更多 ${hiddenTags.length} 个标签：${hiddenTags.join("、")}`}>
        +{hiddenTags.length}
      </span>}
      <div ref={probeRef} className="board-card-badge-probe" aria-hidden="true">
        {folderName && <>{folder()}{folder(true)}</>}
        {tags.map(tag)}
        {tags.map((_, index) => <span key={index} className="board-card-badge board-card-tag-more">+{index + 1}</span>)}
      </div>
    </div>
  );
};
