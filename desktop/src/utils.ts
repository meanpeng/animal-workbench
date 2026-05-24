export function parseBeijingTime(dateStr: string): Date {
  const s = dateStr.trim();
  if (!/[+-]\d{2}:\d{2}|Z$/i.test(s)) {
    return new Date(s + "+08:00");
  }
  return new Date(s);
}

export function formatBeijingTime(dateStr: string | undefined | null): string {
  if (!dateStr) return "-";
  return parseBeijingTime(dateStr).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
