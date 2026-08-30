import { ROUNDNESS } from "@excalidraw/common";

import type { NodeThemeStyle } from "./types";

export type PalettePreset = {
  root: {
    bgLight: string;
    strokeLight: string;
    bgDark: string;
    strokeDark: string;
  };
  branches: Array<{
    bgLight: string;
    strokeLight: string;
    bgDark: string;
    strokeDark: string;
  }>;
};

export const MORANDI_PALETTE: PalettePreset = {
  root: {
    bgLight: "#d0ebff",
    strokeLight: "#1971c2",
    bgDark: "#1864ab",
    strokeDark: "#a5d8ff",
  },
  branches: [
    {
      bgLight: "#ffe8cc",
      strokeLight: "#d9480f",
      bgDark: "#d9480f",
      strokeDark: "#ffd8a8",
    },
    {
      bgLight: "#d3f9d8",
      strokeLight: "#2b8a3e",
      bgDark: "#2b8a3e",
      strokeDark: "#b2f2bb",
    },
    {
      bgLight: "#eebefa",
      strokeLight: "#862e9c",
      bgDark: "#862e9c",
      strokeDark: "#e599f7",
    },
    {
      bgLight: "#ffdeeb",
      strokeLight: "#c2255c",
      bgDark: "#c2255c",
      strokeDark: "#fcc2d7",
    },
    {
      bgLight: "#fff3bf",
      strokeLight: "#d9730d",
      bgDark: "#e67700",
      strokeDark: "#ffec99",
    },
    {
      bgLight: "#c5f6fa",
      strokeLight: "#0b7285",
      bgDark: "#0b7285",
      strokeDark: "#99e9f2",
    },
    {
      bgLight: "#dbe4ff",
      strokeLight: "#364fc7",
      bgDark: "#364fc7",
      strokeDark: "#bac8ff",
    },
  ],
};

export const getBranchLineColor = (
  branchIndex: number,
  isDark = false,
): string => {
  const branch =
    MORANDI_PALETTE.branches[
      Math.abs(branchIndex) % MORANDI_PALETTE.branches.length
    ];
  return isDark ? branch.strokeDark : branch.strokeLight;
};

export const getNodeStyle = (
  level: number,
  branchIndex: number,
  isDark = false,
): NodeThemeStyle => {
  if (level === 0) {
    return {
      backgroundColor: isDark
        ? MORANDI_PALETTE.root.bgDark
        : MORANDI_PALETTE.root.bgLight,
      strokeColor: isDark
        ? MORANDI_PALETTE.root.strokeDark
        : MORANDI_PALETTE.root.strokeLight,
      textColor: isDark ? "#ffffff" : "#1e1e1e",
      strokeWidth: 2,
      roundness: ROUNDNESS.ADAPTIVE_RADIUS,
      fillStyle: "solid",
    };
  }

  const branch =
    MORANDI_PALETTE.branches[
      Math.abs(branchIndex) % MORANDI_PALETTE.branches.length
    ];

  if (level === 1) {
    return {
      backgroundColor: isDark ? branch.bgDark : branch.bgLight,
      strokeColor: isDark ? branch.strokeDark : branch.strokeLight,
      textColor: isDark ? "#ffffff" : "#1e1e1e",
      strokeWidth: 2,
      roundness: ROUNDNESS.ADAPTIVE_RADIUS,
      fillStyle: "solid",
    };
  }

  // Level 2+
  return {
    backgroundColor: isDark ? "#2c2c2c" : "#ffffff",
    strokeColor: isDark ? branch.strokeDark : branch.strokeLight,
    textColor: isDark ? "#e0e0e0" : "#2b2b2b",
    strokeWidth: 1.5,
    roundness: ROUNDNESS.PROPORTIONAL_RADIUS,
    fillStyle: "solid",
  };
};
