export function sanitizeClassName(displayName: string): string {
  let name = displayName.trim().toLowerCase().replace(/\s+/g, "_");
  name = name.replace(/[^a-z0-9_.-]+/g, "_").replace(/^_|_$/g, "").replace(/_{2,}/g, "_");
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    name = "class_" + Date.now();
  }
  return name;
}
