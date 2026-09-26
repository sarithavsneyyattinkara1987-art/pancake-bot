import { describe, expect, test } from "bun:test";
import { findPath, type WorldView } from "../src/bot/core/pathfinding";
import type { Vec3 } from "../src/bot/core/world";

/** Flat floor at y=63 (solid id 1), air above, unloaded outside |x|,|z| > 40. */
function flatWorld(overrides?: (x: number, y: number, z: number) => number | null | undefined): WorldView {
  return {
    blockAt: (x, y, z) => {
      if (Math.abs(x) > 40 || Math.abs(z) > 40 || y < 0 || y > 200) return null;
      const custom = overrides?.(x, y, z);
      if (custom !== undefined) return custom;
      return y <= 63 ? 1 : 0;
    },
    registry: null,
    minY: 0,
    height: 256,
  };
}

const start: Vec3 = { x: 0.5, y: 64, z: 0.5 };
const goal: Vec3 = { x: 6.5, y: 64, z: 0.5 };

describe("findPath", () => {
  test("walks a straight line on flat ground", () => {
    const result = findPath(flatWorld(), start, goal);
    expect(result.ok).toBe(true);
    expect(result.path.length).toBe(6);
    const last = result.path[result.path.length - 1];
    expect(last.x).toBe(6);
    expect(last.y).toBe(64);
    expect(last.z).toBe(0);
    expect(result.path.every((step) => step.action === "walk")).toBe(true);
  });

  test("detours around a two-block wall", () => {
    const wall = (x: number, y: number, z: number): number | undefined =>
      x === 3 && z === 0 && (y === 64 || y === 65) ? 1 : undefined;
    const result = findPath(flatWorld((x, y, z) => wall(x, y, z)), start, goal);
    expect(result.ok).toBe(true);
    const last = result.path[result.path.length - 1];
    expect(last.x).toBe(6);
    expect(last.y).toBe(64);
    // never walks through the wall column
    expect(result.path.some((s) => s.x === 3 && s.z === 0)).toBe(false);
    // does move around it
    expect(result.path.some((s) => s.z !== 0)).toBe(true);
  });

  test("jumps onto a one-block step", () => {
    const step = (x: number, y: number, z: number): number | undefined =>
      x === 1 && y === 64 && z === 0 ? 1 : undefined;
    const result = findPath(flatWorld((x, y, z) => step(x, y, z)), start, { x: 3.5, y: 64, z: 0.5 });
    expect(result.ok).toBe(true);
    expect(result.path.some((s) => s.action === "jump")).toBe(true);
    const last = result.path[result.path.length - 1];
    expect(last.x).toBe(3);
    expect(last.y).toBe(64);
  });

  test("returns a failure when the start island has no moves", () => {
    const isolated: WorldView = {
      blockAt: (x, y, z) => (x === 0 && z === 0 && y === 63 ? 1 : null),
      registry: null,
      minY: 0,
      height: 256,
    };
    const result = findPath(isolated, start, goal);
    expect(result.ok).toBe(false);
    expect(result.path.length).toBe(0);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("fails when the start position is not loaded", () => {
    const nowhere: WorldView = {
      blockAt: () => null,
      registry: null,
      minY: 0,
      height: 256,
    };
    const result = findPath(nowhere, start, goal);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not loaded/i);
  });

  test("tolerance stops near the goal instead of exactly on it", () => {
    const result = findPath(flatWorld(), start, { x: 6.5, y: 64, z: 0.5 }, { tolerance: 2 });
    expect(result.ok).toBe(true);
    const last = result.path[result.path.length - 1];
    expect(Math.max(Math.abs(last.x - 6), Math.abs(last.z - 0))).toBeLessThanOrEqual(2);
  });
});
