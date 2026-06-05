/**
 * readEmbeddedConfigStore tests. The function reads the JSON embedded in the
 * <script id="embeddedConfig"> block (present only in the rs-web build) and
 * returns a normalised store, or null when absent/empty/invalid. We drive it
 * by temporarily overriding the preload's document.getElementById stub.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readEmbeddedConfigStore } from "../src/config";

const doc = (globalThis as any).document;
const originalGetById = doc.getElementById;

afterEach(() => { doc.getElementById = originalGetById; });

function setEmbedded(text: string | null): void {
  doc.getElementById = (id: string) =>
    id === "embeddedConfig"
      ? (text == null ? null : { textContent: text })
      : originalGetById(id);
}

describe("readEmbeddedConfigStore", () => {
  it("parses and normalises a valid embedded store", () => {
    setEmbedded(JSON.stringify({ version: 1, configs: { default: { devices: [], links: [] } } }));
    const store = readEmbeddedConfigStore();
    expect(store).not.toBeNull();
    expect(store.configs.default).toBeDefined();
  });

  it("returns null for empty / whitespace content", () => {
    setEmbedded("");
    expect(readEmbeddedConfigStore()).toBeNull();
    setEmbedded("   \n  ");
    expect(readEmbeddedConfigStore()).toBeNull();
  });

  it("returns null (no throw) for invalid JSON", () => {
    setEmbedded("{ not valid json");
    expect(readEmbeddedConfigStore()).toBeNull();
  });

  it("returns null when the element is absent", () => {
    setEmbedded(null);
    expect(readEmbeddedConfigStore()).toBeNull();
  });
});
