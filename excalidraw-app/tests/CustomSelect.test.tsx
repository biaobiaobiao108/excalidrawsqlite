import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CustomSelect } from "../components/CustomSelect";

const options = [
  { value: "", label: "全部" },
  { value: "one", label: "选项一" },
  { value: "two", label: "选项二" },
];

describe("CustomSelect", () => {
  it("supports keyboard selection and escape", () => {
    const onChange = vi.fn();
    render(
      <CustomSelect
        value=""
        options={options}
        onChange={onChange}
        ariaLabel="筛选"
      />,
    );

    const trigger = screen.getByRole("button", { name: "筛选" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("one");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when clicking outside", () => {
    render(
      <>
        <CustomSelect
          value=""
          options={options}
          onChange={vi.fn()}
          ariaLabel="筛选"
        />
        <button type="button">外部按钮</button>
      </>,
    );

    const trigger = screen.getByRole("button", { name: "筛选" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("button", { name: "外部按钮" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
